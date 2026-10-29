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
    memberType: 'YSYX' | 'ICIL';
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
export type Session = {
    id: string;
    layoutId: string;
    layout: Layout;
    startsAt: string;
    endsAt: string;
    requiredAssistants: number;
    open: boolean;
    icilOnly?: boolean;
    cancelledAt?: string | null;
    allowed: boolean;
    adminReady: boolean;
    hasAdminSeat?: boolean;
    assistantPresent?: boolean;
    staffPresenceWindows?: { startsAt: string; endsAt: string }[];
    bookingBlocked?: boolean;
    bookingBlocks?: { id: string; kind: 'SESSION' | 'DAY'; startsAt: string; endsAt: string; reason: string }[];
    bookingBlock?: { id: string; kind: 'SESSION' | 'DAY'; startsAt: string; endsAt: string; reason: string } | null;
    sessionBlocked?: boolean;
    dayBlocked?: boolean;
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
const LAYOUT_UPDATED_EVENT = 'station:layout-updated';
const LAYOUT_UPDATED_STORAGE_KEY = 'station-layout-updated';
export function announceLayoutUpdate() {
    if (typeof window === 'undefined')
        return;
    const timestamp = String(Date.now());
    window.dispatchEvent(new Event(LAYOUT_UPDATED_EVENT));
    try {
        window.localStorage.setItem(LAYOUT_UPDATED_STORAGE_KEY, timestamp);
    }
    catch {
        // Same-tab listeners still receive the custom event when storage is unavailable.
    }
}
export function subscribeToLayoutUpdates(listener: () => void) {
    if (typeof window === 'undefined')
        return () => {};
    const onStorage = (event: StorageEvent) => {
        if (event.key === LAYOUT_UPDATED_STORAGE_KEY)
            listener();
    };
    window.addEventListener(LAYOUT_UPDATED_EVENT, listener);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(LAYOUT_UPDATED_EVENT, listener);
        window.removeEventListener('storage', onStorage);
    };
}
