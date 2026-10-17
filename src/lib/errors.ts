export class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
    }
}
export function check(condition: unknown, message: string, status = 400): asserts condition { if (!condition)
    throw new HttpError(status, message); }
