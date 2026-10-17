export type Group = {
    id: string;
    name: string;
    canReserve: boolean;
    weeklyRules: {
        weekday: number;
        startMinute: number;
        endMinute: number;
    }[];
    dateRules: {
        date: string;
        allowed: boolean;
        startMinute: number;
        endMinute: number;
    }[];
    _count?: {
        users: number;
    };
};
export type User = {
    id: string;
    name: string;
    email: string;
    role: 'USER' | 'ADMIN' | 'ASSISTANT';
    enabled: boolean;
    groupId: string;
    group: Group;
};
export type Element = {
    id: string;
    kind: 'DESK' | 'BOOTH' | 'DIVIDER' | 'LABEL';
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
};
export type Seat = {
    id: string;
    code: string;
    x: number;
    y: number;
    rotation: number;
    enabled: boolean;
    elementId?: string | null;
};
export type Venue = {
    id: string;
    name: string;
    location: string;
};
export type Layout = {
    id: string;
    name: string;
    venueId: string;
    venue: Venue;
    status: 'DRAFT' | 'PUBLISHED';
    width: number;
    height: number;
    elements: Element[];
    seats: Seat[];
};
export type Course = {
    id: string;
    name: string;
    instructor: string;
    description: string;
};
export type Session = {
    id: string;
    courseId: string;
    course: Course;
    layoutId: string;
    layout: Layout;
    startsAt: string;
    endsAt: string;
    requiredAssistants: number;
    open: boolean;
    allowed: boolean;
    coverage: {
        id: string;
        assistantId: string;
        assistant: {
            id: string;
            name: string;
        };
    }[];
    reservations: {
        id?: string;
        seatId: string;
        mine?: boolean;
        userId?: string;
    }[];
};
export type Reservation = {
    id: string;
    sessionId: string;
    session: Session;
    seat: Seat;
    user: User;
    cancelledAt: string | null;
    createdAt: string;
};
export type Coverage = {
    id: string;
    session: Session;
    assistant?: {
        name: string;
        email: string;
    };
};
export async function api<T = Record<string, unknown>>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const res = await fetch(`/api/${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : undefined, body: data ? JSON.stringify(data) : undefined, cache: 'no-store' });
    const json = await res.json();
    if (!res.ok)
        throw new Error(json.error ?? '请求失败');
    return json;
}
