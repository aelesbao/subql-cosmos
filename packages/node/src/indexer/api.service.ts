// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { TextDecoder } from 'util';
import {
  CosmWasmClient,
  IndexedTx,
  JsonObject,
} from '@cosmjs/cosmwasm-stargate';
import { fromUtf8, toHex, toUtf8 } from '@cosmjs/encoding';
import { Uint53 } from '@cosmjs/math';
import { DecodeObject, GeneratedType, Registry } from '@cosmjs/proto-signing';
import {
  Block,
  defaultRegistryTypes,
  ProtobufRpcClient,
  QueryClient,
} from '@cosmjs/stargate';
import {
  Tendermint37Client,
  toRfc3339WithNanoseconds,
} from '@cosmjs/tendermint-rpc';
import {
  BlockResponse,
  Validator,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CosmosProjectNetConfig } from '@subql/common-cosmos';
import {
  getLogger,
  ConnectionPoolService,
  ApiService as BaseApiService,
} from '@subql/node-core';
import { CosmWasmSafeClient } from '@subql/types-cosmos/interfaces';
import { QueryClientImpl } from 'cosmjs-types/cosmwasm/wasm/v1/query';
import {
  MsgClearAdmin,
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgMigrateContract,
  MsgStoreCode,
  MsgUpdateAdmin,
} from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { SubqueryProject } from '../configure/SubqueryProject';
import * as CosmosUtil from '../utils/cosmos';
import { CosmosClientConnection } from './cosmosClient.connection';
import { BlockContent } from './types';

const logger = getLogger('api');

@Injectable()
export class ApiService
  extends BaseApiService<CosmosClient, CosmosSafeClient, BlockContent[]>
  implements OnApplicationShutdown
{
  private fetchBlocksBatches = CosmosUtil.fetchBlocksBatches;
  registry: Registry;

  constructor(
    @Inject('ISubqueryProject') private project: SubqueryProject,
    connectionPoolService: ConnectionPoolService<CosmosClientConnection>,
    eventEmitter: EventEmitter2,
  ) {
    super(connectionPoolService, eventEmitter);
  }

  private async buildRegistry(): Promise<Registry> {
    const chaintypes = await this.getChainType(this.project.network);

    const wasmTypes: ReadonlyArray<[string, GeneratedType]> = [
      ['/cosmwasm.wasm.v1.MsgClearAdmin', MsgClearAdmin],
      ['/cosmwasm.wasm.v1.MsgExecuteContract', MsgExecuteContract],
      ['/cosmwasm.wasm.v1.MsgMigrateContract', MsgMigrateContract],
      ['/cosmwasm.wasm.v1.MsgStoreCode', MsgStoreCode],
      ['/cosmwasm.wasm.v1.MsgInstantiateContract', MsgInstantiateContract],
      ['/cosmwasm.wasm.v1.MsgUpdateAdmin', MsgUpdateAdmin],
    ];

    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);

    for (const typeurl in chaintypes) {
      registry.register(typeurl, chaintypes[typeurl]);
    }

    return registry;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connectionPoolService.onApplicationShutdown();
  }

  async init(): Promise<ApiService> {
    const { network } = this.project;

    this.registry = await this.buildRegistry();

    await this.createConnections(
      network,
      (endpoint) =>
        CosmosClientConnection.create(
          endpoint,
          this.fetchBlocksBatches,
          this.registry,
        ),
      (connection: CosmosClientConnection) => {
        const api = connection.unsafeApi;
        return api.getChainId();
      },
    );

    return this;
  }

  get api(): CosmosClient {
    return this.unsafeApi;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getSafeApi(height: number): Promise<CosmosSafeClient> {
    return this.connectionPoolService.api.safeApi(height);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChainType(
    network: Partial<CosmosProjectNetConfig>,
  ): Promise<Record<string, GeneratedType>> {
    if (!network.chaintypes) {
      return {};
    }

    const res: Record<string, GeneratedType> = {};
    for (const [
      userPackageName,
      { messages, packageName },
    ] of network.chaintypes) {
      const pkgName = packageName ?? userPackageName;
      for (const msg of messages) {
        logger.info(`Registering chain message type "/${pkgName}.${msg}"`);
        const msgObj = network.chaintypes.protoRoot.lookupTypeOrEnum(
          `${pkgName}.${msg}`,
        );
        res[`/${pkgName}.${msg}`] = msgObj;
      }
    }
    return res;
  }
}

export class CosmosClient extends CosmWasmClient {
  constructor(
    private readonly tendermintClient: Tendermint37Client,
    public registry: Registry,
  ) {
    super(tendermintClient);
  }

  /*
  async chainId(): Promise<string> {
    return this.getChainId();
  }

  async finalisedHeight(): Promise<number> {
    return this.getHeight();
  }
  */

  // eslint-disable-next-line @typescript-eslint/require-await
  async blockInfo(height?: number): Promise<BlockResponse> {
    return this.tendermintClient.block(height);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async txInfoByHeight(height: number): Promise<readonly IndexedTx[]> {
    return this.searchTx({ height: height });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async blockResults(height: number): Promise<BlockResultsResponse> {
    return this.tendermintClient.blockResults(height);
  }

  decodeMsg<T = unknown>(msg: DecodeObject): T {
    try {
      const decodedMsg = this.registry.decode(msg);
      if (
        [
          '/cosmwasm.wasm.v1.MsgExecuteContract',
          '/cosmwasm.wasm.v1.MsgMigrateContract',
          '/cosmwasm.wasm.v1.MsgInstantiateContract',
        ].includes(msg.typeUrl)
      ) {
        decodedMsg.msg = JSON.parse(new TextDecoder().decode(decodedMsg.msg));
      }
      return decodedMsg;
    } catch (e) {
      logger.error(e, 'Failed to decode message');
      throw e;
    }
  }

  static handleError(e: Error): Error {
    const formatted_error: Error = e;
    try {
      const message = JSON.parse(e.message);
      if (
        message.data &&
        message.data.includes(`is not available, lowest height is`)
      ) {
        formatted_error.message = `${message.data}\nINFO: This most likely means the provided endpoint is a pruned node. An archive/full node is needed to access historical data`;
      }
    } catch (err) {
      if (e.message === 'Request failed with status code 429') {
        formatted_error.name = 'RateLimitError';
      } else if (e.message === 'Request failed with status code 403') {
        formatted_error.name = 'Forbidden';
      }
    }
    return formatted_error;
  }
}

// TODO make this class not exported and expose interface instead
export class CosmosSafeClient
  extends CosmWasmClient
  implements CosmWasmSafeClient
{
  readonly height: number;
  private readonly safeQueryClient: QueryClient & SafeWasmExtension;

  constructor(tmClient: Tendermint37Client, height: number) {
    super(tmClient);

    this.height = height;
    this.safeQueryClient = QueryClient.withExtensions(
      tmClient,
      setupSafeWasmExtension(height),
    );
  }

  // Deprecate
  async getBlock(): Promise<Block> {
    const response = await this.forceGetTmClient().block(this.height);
    return {
      id: toHex(response.blockId.hash).toUpperCase(),
      header: {
        version: {
          block: new Uint53(response.block.header.version.block).toString(),
          app: new Uint53(response.block.header.version.app).toString(),
        },
        height: response.block.header.height,
        chainId: response.block.header.chainId,
        time: toRfc3339WithNanoseconds(response.block.header.time),
      },
      txs: response.block.txs,
    };
  }

  async validators(): Promise<readonly Validator[]> {
    return (
      await this.forceGetTmClient().validators({
        height: this.height,
      })
    ).validators;
  }

  async searchTx(): Promise<readonly IndexedTx[]> {
    const txs: readonly IndexedTx[] = await this.safeTxsQuery(
      `tx.height=${this.height}`,
    );
    return txs;
  }

  private async safeTxsQuery(query: string): Promise<readonly IndexedTx[]> {
    const results = await this.forceGetTmClient().txSearchAll({ query: query });
    return results.txs.map((tx) => {
      return {
        txIndex: tx.index,
        height: tx.height,
        hash: toHex(tx.hash).toUpperCase(),
        code: tx.result.code,
        rawLog: tx.result.log || '',
        tx: tx.tx,
        gasUsed: tx.result.gasUsed,
        gasWanted: tx.result.gasWanted,
        events: tx.result.events.map((evt) => ({
          ...evt,
          attributes: evt.attributes.map((attr) => ({
            key: Buffer.from(attr.key).toString('utf8'),
            value: Buffer.from(attr.value).toString('utf8'),
          })),
        })),
      };
    });
  }

  async queryContractSmart(
    address: string,
    queryMsg: JsonObject,
  ): Promise<JsonObject> {
    try {
      return await this.safeQueryClient.wasm.queryContractSmart(
        address,
        queryMsg,
      );
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.startsWith('not found: contract')) {
          throw new Error(`No contract found at address "${address}"`);
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }
}

interface SafeWasmExtension {
  readonly wasm: {
    readonly queryContractSmart: (
      address: string,
      query: JsonObject,
      height?: number,
    ) => Promise<JsonObject>;
  };
}

function setupSafeWasmExtension(
  height?: number,
): (base: QueryClient) => SafeWasmExtension {
  return (base: QueryClient) => {
    const rpc = createProtobufRpcClient(base, height);
    const queryService = new QueryClientImpl(rpc);

    return {
      wasm: {
        queryContractSmart: async (
          address: string,
          query: JsonObject,
        ): Promise<JsonObject> => {
          const request = {
            address: address,
            queryData: toUtf8(JSON.stringify(query)),
          };
          const { data } = await queryService.SmartContractState(request);
          // By convention, smart queries must return a valid JSON document (see https://github.com/CosmWasm/cosmwasm/issues/144)
          let responseText: string;
          try {
            responseText = fromUtf8(data);
          } catch (error) {
            throw new Error(
              `Could not UTF-8 decode smart query response from contract: ${error}`,
            );
          }
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return JSON.parse(responseText);
          } catch (error) {
            throw new Error(
              `Could not JSON parse smart query response from contract: ${error}`,
            );
          }
        },
      },
    };
  };
}

function createProtobufRpcClient(
  base: QueryClient,
  height?: number,
): ProtobufRpcClient {
  return {
    request: async (
      service: string,
      method: string,
      data: Uint8Array,
    ): Promise<Uint8Array> => {
      const path = `/${service}/${method}`;
      const response = await base.queryAbci(path, data, height);
      return response.value;
    },
  };
}
