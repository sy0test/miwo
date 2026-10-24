import type { Knex } from "knex";
import { reserveInTransaction } from "@/billing/ledger";

export interface SubmitBilledJobInput<TBusiness> {
  db: Knex;
  userId: number;
  estimateMicro: bigint | ((trx: Knex.Transaction) => Promise<bigint>);
  idempotencyKey: string;
  createBusinessRows: (trx: Knex.Transaction) => Promise<TBusiness>;
  enqueue: (trx: Knex.Transaction, business: TBusiness) => Promise<{ jobId: string; created: boolean }>;
  resolveExistingBusiness?: (trx: Knex.Transaction, jobId: string) => Promise<TBusiness>;
}

export interface SubmitBilledJobResult<TBusiness> {
  business: TBusiness;
  jobId: string;
  deduplicated: boolean;
}

export class InsufficientBalanceError extends Error {
  readonly httpStatus = 402;

  constructor(options?: ErrorOptions) {
    super("Insufficient available balance", options);
    this.name = "InsufficientBalanceError";
  }
}

class DuplicateSubmission extends Error {
  constructor(readonly jobId: string) {
    super("Active job already exists");
  }
}

export async function submitBilledJob<TBusiness>(
  input: SubmitBilledJobInput<TBusiness>,
): Promise<SubmitBilledJobResult<TBusiness>> {
  const enqueue = input.enqueue;
  try {
    return await input.db.transaction(async (trx) => {
      try {
        return await trx.transaction(async (savepoint) => {
          const business = await input.createBusinessRows(savepoint);
          const queued = await enqueue(savepoint, business);
          if (!queued.created) throw new DuplicateSubmission(queued.jobId);
          const estimateMicro = typeof input.estimateMicro === "function"
            ? await input.estimateMicro(savepoint)
            : input.estimateMicro;
          await reserveInTransaction(savepoint, {
            userId: input.userId,
            amountMicro: estimateMicro,
            refType: "job",
            refId: queued.jobId,
            idempotencyKey: input.idempotencyKey,
          });
          return { business, jobId: queued.jobId, deduplicated: false };
        });
      } catch (error) {
        if (error instanceof DuplicateSubmission) {
          if (!input.resolveExistingBusiness) {
            throw new Error("resolveExistingBusiness is required when an active job is deduplicated", { cause: error });
          }
          const business = await input.resolveExistingBusiness(trx, error.jobId);
          return { business, jobId: error.jobId, deduplicated: true };
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Insufficient available balance") {
      throw new InsufficientBalanceError({ cause: error });
    }
    throw error;
  }
}
