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
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 4)
                continue;
            throw error;
        }
    }
}
