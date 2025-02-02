import { SqliteJsonRow, SqliteJsonValue, SqlSyncRules } from '@powersync/service-sync-rules';
import * as bson from 'bson';
import * as mongo from 'mongodb';

import { DisposableObserver, logger } from '@powersync/lib-services-framework';
import * as timers from 'timers/promises';
import * as db from '../../db/db-index.js';
import * as util from '../../util/util-index.js';
import {
  BucketDataBatchOptions,
  BucketStorageBatch,
  CompactOptions,
  DEFAULT_DOCUMENT_BATCH_LIMIT,
  DEFAULT_DOCUMENT_CHUNK_LIMIT_BYTES,
  FlushedResult,
  ParseSyncRulesOptions,
  PersistedSyncRulesContent,
  ReplicationCheckpoint,
  ResolveTableOptions,
  ResolveTableResult,
  StartBatchOptions,
  SyncBucketDataBatch,
  SyncRulesBucketStorage,
  SyncRulesBucketStorageListener,
  SyncRuleStatus,
  TerminateOptions
} from '../BucketStorage.js';
import { ChecksumCache, FetchPartialBucketChecksum, PartialChecksum, PartialChecksumMap } from '../ChecksumCache.js';
import { MongoBucketStorage } from '../MongoBucketStorage.js';
import { SourceTable } from '../SourceTable.js';
import {
  BatchedCustomWriteCheckpointOptions,
  ManagedWriteCheckpointOptions,
  SyncStorageLastWriteCheckpointFilters,
  WriteCheckpointAPI,
  WriteCheckpointMode
} from '../WriteCheckpointAPI.js';
import { PowerSyncMongo } from './db.js';
import { BucketDataDocument, BucketDataKey, SourceKey, SyncRuleState } from './models.js';
import { MongoBucketBatch } from './MongoBucketBatch.js';
import { MongoCompactor } from './MongoCompactor.js';
import { MongoWriteCheckpointAPI } from './MongoWriteCheckpointAPI.js';
import { BSON_DESERIALIZE_OPTIONS, idPrefixFilter, mapOpEntry, readSingleBatch, serializeLookup } from './util.js';

export class MongoSyncBucketStorage
  extends DisposableObserver<SyncRulesBucketStorageListener>
  implements SyncRulesBucketStorage
{
  private readonly db: PowerSyncMongo;
  private checksumCache = new ChecksumCache({
    fetchChecksums: (batch) => {
      return this.getChecksumsInternal(batch);
    }
  });

  private parsedSyncRulesCache: { parsed: SqlSyncRules; options: ParseSyncRulesOptions } | undefined;
  private writeCheckpointAPI: WriteCheckpointAPI;

  constructor(
    public readonly factory: MongoBucketStorage,
    public readonly group_id: number,
    private readonly sync_rules: PersistedSyncRulesContent,
    public readonly slot_name: string,
    writeCheckpointMode: WriteCheckpointMode = WriteCheckpointMode.MANAGED
  ) {
    super();
    this.db = factory.db;
    this.writeCheckpointAPI = new MongoWriteCheckpointAPI({
      db: this.db,
      mode: writeCheckpointMode
    });
  }

  get writeCheckpointMode() {
    return this.writeCheckpointAPI.writeCheckpointMode;
  }

  setWriteCheckpointMode(mode: WriteCheckpointMode): void {
    this.writeCheckpointAPI.setWriteCheckpointMode(mode);
  }

  batchCreateCustomWriteCheckpoints(checkpoints: BatchedCustomWriteCheckpointOptions[]): Promise<void> {
    return this.writeCheckpointAPI.batchCreateCustomWriteCheckpoints(
      checkpoints.map((checkpoint) => ({ ...checkpoint, sync_rules_id: this.group_id }))
    );
  }

  createCustomWriteCheckpoint(checkpoint: BatchedCustomWriteCheckpointOptions): Promise<bigint> {
    return this.writeCheckpointAPI.createCustomWriteCheckpoint({
      ...checkpoint,
      sync_rules_id: this.group_id
    });
  }

  createManagedWriteCheckpoint(checkpoint: ManagedWriteCheckpointOptions): Promise<bigint> {
    return this.writeCheckpointAPI.createManagedWriteCheckpoint(checkpoint);
  }

  lastWriteCheckpoint(filters: SyncStorageLastWriteCheckpointFilters): Promise<bigint | null> {
    return this.writeCheckpointAPI.lastWriteCheckpoint({
      ...filters,
      sync_rules_id: this.group_id
    });
  }

  getParsedSyncRules(options: ParseSyncRulesOptions): SqlSyncRules {
    const { parsed, options: cachedOptions } = this.parsedSyncRulesCache ?? {};
    /**
     * Check if the cached sync rules, if present, had the same options.
     * Parse sync rules if the options are different or if there is no cached value.
     */
    if (!parsed || options.defaultSchema != cachedOptions?.defaultSchema) {
      this.parsedSyncRulesCache = { parsed: this.sync_rules.parsed(options).sync_rules, options };
    }

    return this.parsedSyncRulesCache!.parsed;
  }

  async getCheckpoint(): Promise<ReplicationCheckpoint> {
    const doc = await this.db.sync_rules.findOne(
      { _id: this.group_id },
      {
        projection: { last_checkpoint: 1, last_checkpoint_lsn: 1 }
      }
    );
    return {
      checkpoint: util.timestampToOpId(doc?.last_checkpoint ?? 0n),
      lsn: doc?.last_checkpoint_lsn ?? null
    };
  }

  async startBatch(
    options: StartBatchOptions,
    callback: (batch: BucketStorageBatch) => Promise<void>
  ): Promise<FlushedResult | null> {
    const doc = await this.db.sync_rules.findOne(
      {
        _id: this.group_id
      },
      { projection: { last_checkpoint_lsn: 1, no_checkpoint_before: 1 } }
    );
    const checkpoint_lsn = doc?.last_checkpoint_lsn ?? null;

    await using batch = new MongoBucketBatch({
      db: this.db,
      syncRules: this.sync_rules.parsed(options).sync_rules,
      groupId: this.group_id,
      slotName: this.slot_name,
      lastCheckpointLsn: checkpoint_lsn,
      noCheckpointBeforeLsn: doc?.no_checkpoint_before ?? options.zeroLSN,
      storeCurrentData: options.storeCurrentData
    });
    this.iterateListeners((cb) => cb.batchStarted?.(batch));

    await callback(batch);
    await batch.flush();
    if (batch.last_flushed_op) {
      return { flushed_op: String(batch.last_flushed_op) };
    } else {
      return null;
    }
  }

  async resolveTable(options: ResolveTableOptions): Promise<ResolveTableResult> {
    const { group_id, connection_id, connection_tag, entity_descriptor } = options;

    const { schema, name: table, objectId, replicationColumns } = entity_descriptor;

    const columns = replicationColumns.map((column) => ({
      name: column.name,
      type: column.type,
      type_oid: column.typeId
    }));
    let result: ResolveTableResult | null = null;
    await this.db.client.withSession(async (session) => {
      const col = this.db.source_tables;
      let doc = await col.findOne(
        {
          group_id: group_id,
          connection_id: connection_id,
          relation_id: objectId,
          schema_name: schema,
          table_name: table,
          replica_id_columns2: columns
        },
        { session }
      );
      if (doc == null) {
        doc = {
          _id: new bson.ObjectId(),
          group_id: group_id,
          connection_id: connection_id,
          relation_id: objectId,
          schema_name: schema,
          table_name: table,
          replica_id_columns: null,
          replica_id_columns2: columns,
          snapshot_done: false
        };

        await col.insertOne(doc, { session });
      }
      const sourceTable = new SourceTable(
        doc._id,
        connection_tag,
        objectId,
        schema,
        table,
        replicationColumns,
        doc.snapshot_done ?? true
      );
      sourceTable.syncEvent = options.sync_rules.tableTriggersEvent(sourceTable);
      sourceTable.syncData = options.sync_rules.tableSyncsData(sourceTable);
      sourceTable.syncParameters = options.sync_rules.tableSyncsParameters(sourceTable);

      const truncate = await col
        .find(
          {
            group_id: group_id,
            connection_id: connection_id,
            _id: { $ne: doc._id },
            $or: [{ relation_id: objectId }, { schema_name: schema, table_name: table }]
          },
          { session }
        )
        .toArray();
      result = {
        table: sourceTable,
        dropTables: truncate.map(
          (doc) =>
            new SourceTable(
              doc._id,
              connection_tag,
              doc.relation_id ?? 0,
              doc.schema_name,
              doc.table_name,
              doc.replica_id_columns2?.map((c) => ({ name: c.name, typeOid: c.type_oid, type: c.type })) ?? [],
              doc.snapshot_done ?? true
            )
        )
      };
    });
    return result!;
  }

  async getParameterSets(checkpoint: util.OpId, lookups: SqliteJsonValue[][]): Promise<SqliteJsonRow[]> {
    const lookupFilter = lookups.map((lookup) => {
      return serializeLookup(lookup);
    });
    const rows = await this.db.bucket_parameters
      .aggregate([
        {
          $match: {
            'key.g': this.group_id,
            lookup: { $in: lookupFilter },
            _id: { $lte: BigInt(checkpoint) }
          }
        },
        {
          $sort: {
            _id: -1
          }
        },
        {
          $group: {
            _id: '$key',
            bucket_parameters: {
              $first: '$bucket_parameters'
            }
          }
        }
      ])
      .toArray();
    const groupedParameters = rows.map((row) => {
      return row.bucket_parameters;
    });
    return groupedParameters.flat();
  }

  async *getBucketDataBatch(
    checkpoint: util.OpId,
    dataBuckets: Map<string, string>,
    options?: BucketDataBatchOptions
  ): AsyncIterable<SyncBucketDataBatch> {
    if (dataBuckets.size == 0) {
      return;
    }
    let filters: mongo.Filter<BucketDataDocument>[] = [];

    const end = checkpoint ? BigInt(checkpoint) : new bson.MaxKey();
    for (let [name, start] of dataBuckets.entries()) {
      filters.push({
        _id: {
          $gt: {
            g: this.group_id,
            b: name,
            o: BigInt(start)
          },
          $lte: {
            g: this.group_id,
            b: name,
            o: end as any
          }
        }
      });
    }

    const limit = options?.limit ?? DEFAULT_DOCUMENT_BATCH_LIMIT;
    const sizeLimit = options?.chunkLimitBytes ?? DEFAULT_DOCUMENT_CHUNK_LIMIT_BYTES;

    const cursor = this.db.bucket_data.find(
      {
        $or: filters
      },
      {
        session: undefined,
        sort: { _id: 1 },
        limit: limit,
        // Increase batch size above the default 101, so that we can fill an entire batch in
        // one go.
        batchSize: limit,
        // Raw mode is returns an array of Buffer instead of parsed documents.
        // We use it so that:
        // 1. We can calculate the document size accurately without serializing again.
        // 2. We can delay parsing the results until it's needed.
        // We manually use bson.deserialize below
        raw: true,

        // Since we're using raw: true and parsing ourselves later, we don't need bigint
        // support here.
        // Disabling due to https://jira.mongodb.org/browse/NODE-6165, and the fact that this
        // is one of our most common queries.
        useBigInt64: false
      }
    ) as unknown as mongo.FindCursor<Buffer>;

    // We want to limit results to a single batch to avoid high memory usage.
    // This approach uses MongoDB's batch limits to limit the data here, which limits
    // to the lower of the batch count and size limits.
    // This is similar to using `singleBatch: true` in the find options, but allows
    // detecting "hasMore".
    let { data, hasMore } = await readSingleBatch(cursor);
    if (data.length == limit) {
      // Limit reached - could have more data, despite the cursor being drained.
      hasMore = true;
    }

    let batchSize = 0;
    let currentBatch: util.SyncBucketData | null = null;
    let targetOp: bigint | null = null;

    // Ordered by _id, meaning buckets are grouped together
    for (let rawData of data) {
      const row = bson.deserialize(rawData, BSON_DESERIALIZE_OPTIONS) as BucketDataDocument;
      const bucket = row._id.b;

      if (currentBatch == null || currentBatch.bucket != bucket || batchSize >= sizeLimit) {
        let start: string | undefined = undefined;
        if (currentBatch != null) {
          if (currentBatch.bucket == bucket) {
            currentBatch.has_more = true;
          }

          const yieldBatch = currentBatch;
          start = currentBatch.after;
          currentBatch = null;
          batchSize = 0;
          yield { batch: yieldBatch, targetOp: targetOp };
          targetOp = null;
        }

        start ??= dataBuckets.get(bucket);
        if (start == null) {
          throw new Error(`data for unexpected bucket: ${bucket}`);
        }
        currentBatch = {
          bucket,
          after: start,
          has_more: hasMore,
          data: [],
          next_after: start
        };
        targetOp = null;
      }

      const entry = mapOpEntry(row);

      if (row.target_op != null) {
        // MOVE, CLEAR
        if (targetOp == null || row.target_op > targetOp) {
          targetOp = row.target_op;
        }
      }

      currentBatch.data.push(entry);
      currentBatch.next_after = entry.op_id;

      batchSize += rawData.byteLength;
    }

    if (currentBatch != null) {
      const yieldBatch = currentBatch;
      currentBatch = null;
      yield { batch: yieldBatch, targetOp: targetOp };
      targetOp = null;
    }
  }

  async getChecksums(checkpoint: util.OpId, buckets: string[]): Promise<util.ChecksumMap> {
    return this.checksumCache.getChecksumMap(checkpoint, buckets);
  }

  private async getChecksumsInternal(batch: FetchPartialBucketChecksum[]): Promise<PartialChecksumMap> {
    if (batch.length == 0) {
      return new Map();
    }

    const filters: any[] = [];
    for (let request of batch) {
      filters.push({
        _id: {
          $gt: {
            g: this.group_id,
            b: request.bucket,
            o: request.start ? BigInt(request.start) : new bson.MinKey()
          },
          $lte: {
            g: this.group_id,
            b: request.bucket,
            o: BigInt(request.end)
          }
        }
      });
    }

    const aggregate = await this.db.bucket_data
      .aggregate(
        [
          {
            $match: {
              $or: filters
            }
          },
          {
            $group: {
              _id: '$_id.b',
              checksum_total: { $sum: '$checksum' },
              count: { $sum: 1 },
              has_clear_op: {
                $max: {
                  $cond: [{ $eq: ['$op', 'CLEAR'] }, 1, 0]
                }
              }
            }
          }
        ],
        { session: undefined, readConcern: 'snapshot' }
      )
      .toArray();

    return new Map<string, PartialChecksum>(
      aggregate.map((doc) => {
        return [
          doc._id,
          {
            bucket: doc._id,
            partialCount: doc.count,
            partialChecksum: Number(BigInt(doc.checksum_total) & 0xffffffffn) & 0xffffffff,
            isFullChecksum: doc.has_clear_op == 1
          } satisfies PartialChecksum
        ];
      })
    );
  }

  async terminate(options?: TerminateOptions) {
    // Default is to clear the storage except when explicitly requested not to.
    if (!options || options?.clearStorage) {
      await this.clear();
    }
    await this.db.sync_rules.updateOne(
      {
        _id: this.group_id
      },
      {
        $set: {
          state: SyncRuleState.TERMINATED,
          persisted_lsn: null,
          snapshot_done: false
        }
      }
    );
  }

  async getStatus(): Promise<SyncRuleStatus> {
    const doc = await this.db.sync_rules.findOne(
      {
        _id: this.group_id
      },
      {
        projection: {
          snapshot_done: 1,
          last_checkpoint_lsn: 1,
          state: 1
        }
      }
    );
    if (doc == null) {
      throw new Error('Cannot find sync rules status');
    }

    return {
      snapshot_done: doc.snapshot_done,
      active: doc.state == 'ACTIVE',
      checkpoint_lsn: doc.last_checkpoint_lsn
    };
  }

  async clear(): Promise<void> {
    while (true) {
      try {
        await this.clearIteration();
        return;
      } catch (e: unknown) {
        if (e instanceof mongo.MongoServerError && e.codeName == 'MaxTimeMSExpired') {
          logger.info(
            `Clearing took longer than ${db.mongo.MONGO_CLEAR_OPERATION_TIMEOUT_MS}ms, waiting and triggering another iteration.`
          );
          await timers.setTimeout(db.mongo.MONGO_CLEAR_OPERATION_TIMEOUT_MS / 5);
          continue;
        } else {
          throw e;
        }
      }
    }
  }

  private async clearIteration(): Promise<void> {
    // Individual operations here may time out with the maxTimeMS option.
    // It is expected to still make progress, and continue on the next try.

    await this.db.sync_rules.updateOne(
      {
        _id: this.group_id
      },
      {
        $set: {
          snapshot_done: false,
          persisted_lsn: null,
          last_checkpoint_lsn: null,
          last_checkpoint: null,
          no_checkpoint_before: null
        }
      },
      { maxTimeMS: db.mongo.MONGO_CLEAR_OPERATION_TIMEOUT_MS }
    );
    await this.db.bucket_data.deleteMany(
      {
        _id: idPrefixFilter<BucketDataKey>({ g: this.group_id }, ['b', 'o'])
      },
      { maxTimeMS: db.mongo.MONGO_CLEAR_OPERATION_TIMEOUT_MS }
    );
    await this.db.bucket_parameters.deleteMany(
      {
        key: idPrefixFilter<SourceKey>({ g: this.group_id }, ['t', 'k'])
      },
      { maxTimeMS: db.mongo.MONGO_CLEAR_OPERATION_TIMEOUT_MS }
    );

    await this.db.current_data.deleteMany(
      {
        _id: idPrefixFilter<SourceKey>({ g: this.group_id }, ['t', 'k'])
      },
      { maxTimeMS: db.mongo.MONGO_CLEAR_OPERATION_TIMEOUT_MS }
    );

    await this.db.source_tables.deleteMany(
      {
        group_id: this.group_id
      },
      { maxTimeMS: db.mongo.MONGO_CLEAR_OPERATION_TIMEOUT_MS }
    );
  }

  async autoActivate(): Promise<void> {
    await this.db.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        const doc = await this.db.sync_rules.findOne({ _id: this.group_id }, { session });
        if (doc && doc.state == 'PROCESSING') {
          await this.db.sync_rules.updateOne(
            {
              _id: this.group_id
            },
            {
              $set: {
                state: SyncRuleState.ACTIVE
              }
            },
            { session }
          );

          await this.db.sync_rules.updateMany(
            {
              _id: { $ne: this.group_id },
              state: SyncRuleState.ACTIVE
            },
            {
              $set: {
                state: SyncRuleState.STOP
              }
            },
            { session }
          );
        }
      });
    });
  }

  async reportError(e: any): Promise<void> {
    const message = String(e.message ?? 'Replication failure');
    await this.db.sync_rules.updateOne(
      {
        _id: this.group_id
      },
      {
        $set: {
          last_fatal_error: message
        }
      }
    );
  }

  async compact(options?: CompactOptions) {
    return new MongoCompactor(this.db, this.group_id, options).compact();
  }
}
