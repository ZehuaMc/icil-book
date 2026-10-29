import { PrismaClient, Prisma } from '@prisma/client';
const globalDb = globalThis as unknown as {
    prisma?: PrismaClient;
};
export const db = globalDb.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production')
    globalDb.prisma = db;
export type Tx = Prisma.TransactionClient;
export async function serial<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0;; attempt++) {
        try {
            return await db.$transaction(fn, { isolationLevel: 'Serializable', timeout: 15000 });
        }
        catch (error) {
            const serializationFailure = error instanceof Prisma.PrismaClientKnownRequestError
                && (error.code === 'P2034' || (error.code === 'P2010' && typeof error.meta?.code === 'string' && error.meta.code === '40001'));
            if (serializationFailure && attempt < 4)
                continue;
            throw error;
        }
    }
}

/** Serialize mutations that protect a process-wide invariant. */
export async function lockInvariant(tx: Tx, name: string) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${name}))`;
}
