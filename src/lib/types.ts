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
    studentId: string;
    email: string;
    role: 'USER' | 'ADMIN' | 'ASSISTANT';
    enabled: boolean;
    deletedAt?: string | null;
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
    originId?: string | null;
    code: string;
    x: number;
    y: number;
    rotation: number;
    enabled: boolean;
    fixedForAssistant: boolean;
    elementId?: string | null;
};
export type Venue = {
    id: string;
    name: string;
    location: string;
};
export type Layout = {
    id: string;
    sourceLayoutId?: string | null;
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
    cancelledAt?: string | null;
    allowed: boolean;
    adminReady: boolean;
    adminBookings: { id: string; adminId: string; admin: { id: string; name: string } }[];
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
        startsAt?: string;
        endsAt?: string;
        checkedInAt?: string | null;
    }[];
};
export type Reservation = {
    id: string;
    sessionId: string;
    session: Session;
    seat: Seat;
    startsAt: string;
    endsAt: string;
    user: User;
    cancelledAt: string | null;
    checkedInAt: string | null;
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
export type UserNotification = {
    id: string;
    type: string;
    message: string;
    readAt: string | null;
    createdAt: string;
};
export async function api<T = Record<string, unknown>>(path: string, method = 'GET', data?: unknown): Promise<T> {
    const res = await fetch(`/api/${path}`, { method, headers: data ? { 'Content-Type': 'application/json' } : undefined, body: data ? JSON.stringify(data) : undefined, cache: 'no-store' });
    const json = await res.json();
    if (!res.ok)
        throw new Error(json.error ?? '请求失败');
    return json;
}
