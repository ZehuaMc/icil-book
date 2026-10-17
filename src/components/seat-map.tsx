'use client';
import type { Layout, Session, Seat } from '@/lib/types';
export default function SeatMap({ layout, session, selected, onSelect, disabled = false }: {
    layout: Layout;
    session?: Session;
    selected?: string;
    onSelect?: (seat: Seat) => void;
    disabled?: boolean;
}) {
    return <svg className="seat-map" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-label="教学场地座位平面图" role="group">
    <defs><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="#d8dcd4"/></pattern></defs>
    <rect width={layout.width} height={layout.height} fill="url(#grid)" rx="12"/>
    <rect x="24" y="24" width={layout.width - 48} height={layout.height - 48} rx="7" fill="none" stroke="#d6d9cf" strokeWidth="3"/>
    <path d={`M${layout.width / 2 - 50} ${layout.height - 24}h100`} stroke="#fafbf7" strokeWidth="7"/>
    <text x={layout.width / 2} y={layout.height - 6} textAnchor="middle" fontSize="12" fill="#8a9380">入 口 ↑</text>
    {layout.elements.map(e => <g key={e.id} transform={`translate(${e.x} ${e.y}) rotate(${e.rotation} ${e.width / 2} ${e.height / 2})`}>
      {e.kind !== 'LABEL' && <rect width={e.width} height={e.height} rx={e.kind === 'DIVIDER' ? 2 : 10} fill={e.kind === 'DIVIDER' ? '#cbd0c1' : e.kind === 'BOOTH' ? '#e6e9df' : '#eee9df'} stroke={e.kind === 'DIVIDER' ? '#cbd0c1' : '#dad5c9'} strokeWidth="1.5"/>}
      <text x={e.width / 2} y={e.height / 2 + 5} textAnchor="middle" fill="#8b8c7f" fontSize={e.kind === 'LABEL' ? 16 : 12} letterSpacing="2">{e.label}</text>
    </g>)}
    {layout.seats.map(seat => {
            const booking = session?.reservations.find(r => r.seatId === seat.id);
            const state = !seat.enabled ? 'disabled' : booking?.mine ? 'mine' : booking ? 'booked' : selected === seat.id ? 'selected' : 'available';
            const blocked = disabled || !seat.enabled || !!booking;
            const colors = { available: ['#fdfefb', '#a9b99a', '#657951'], selected: ['#788c5d', '#788c5d', '#fff'], mine: ['#788c5d', '#788c5d', '#fff'], booked: ['#e7e9e4', '#d7dcd1', '#a0a698'], disabled: ['#f0f0ed', '#e2e3de', '#b5b7af'] }[state];
            return <g key={seat.id} role="button" tabIndex={blocked ? -1 : 0} aria-disabled={blocked} aria-label={`座位 ${seat.code}，${{ available: '可预约', selected: '已选择', mine: '本人预约', booked: '已预约', disabled: '停用' }[state]}`} onClick={() => !blocked && onSelect?.(seat)} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !blocked) {
                e.preventDefault();
                onSelect?.(seat);
            } }} className={`map-seat ${state}`} transform={`translate(${seat.x} ${seat.y}) rotate(${seat.rotation} 20 21)`}>
        <rect x="2" width="36" height="6" rx="3" fill={colors[1]} opacity="0.7"/><rect y="8" width="40" height="34" rx="8" fill={colors[0]} stroke={colors[1]} strokeWidth="1.6"/><text x="20" y="30" textAnchor="middle" fontSize="12" fontWeight="500" fill={colors[2]}>{seat.code}</text>
      </g>;
        })}
  </svg>;
}
