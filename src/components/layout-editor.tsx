'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Copy, Save, Send, Armchair, Square, Minus, RotateCw, Trash2, ZoomIn, ZoomOut, MousePointer2 } from 'lucide-react';
import Modal from './modal';
import { movement } from '@/lib/geometry';
import { api, type Layout, type Venue, type Element, type Seat } from '@/lib/types';
function makeId() { return crypto.randomUUID(); }
export default function LayoutEditor({ notify }: {
    notify: (s: string) => void;
}) {
    const [layouts, setLayouts] = useState<Layout[]>([]), [venues, setVenues] = useState<Venue[]>([]), [layout, setLayout] = useState<Layout | null>(null), [selected, setSelected] = useState<string[]>([]), [zoom, setZoom] = useState(1), [busy, setBusy] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
    const [prefix, setPrefix] = useState('A'), [start, setStart] = useState(1), [create, setCreate] = useState(false), [newVenue, setNewVenue] = useState(false);
    const drag = useRef<{
        id: string;
        pointerX: number;
        pointerY: number;
        x: number;
        y: number;
        shape: Element | Seat;
        children: Seat[];
    } | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);
    const load = useCallback(async (selectId?: string) => {
        const data = await api<{
            layouts: Layout[];
            venues: Venue[];
        }>('layouts');
        setLayouts(data.layouts);
        setVenues(data.venues);
        setLayout(prev => data.layouts.find(l => l.id === (selectId || prev?.id)) ?? data.layouts[0] ?? null);
        setDirty(false);
        setSelected([]);
    }, []);
    useEffect(() => { load().catch(e => setError(e.message)); }, [load]);
    useEffect(() => { const listener = (e: BeforeUnloadEvent) => { if (dirty)
        e.preventDefault(); }; window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener); }, [dirty]);
    const readonly = layout?.status === 'PUBLISHED';
    function change(next: Layout) { setLayout(next); setDirty(true); }
    function updateObject(id: string, patch: Partial<Element & Seat>) { if (!layout || readonly)
        return; change({ ...layout, elements: layout.elements.map(e => e.id === id ? { ...e, ...patch } : e), seats: layout.seats.map(s => s.id === id ? { ...s, ...patch } : s) }); }
    async function save(publish = false) {
        if (!layout)
            return;
        setBusy(true);
        try {
            await api(`layouts/${layout.id}`, 'PUT', layout);
            if (publish)
                await api(`layouts/${layout.id}/publish`, 'POST');
            await load(layout.id);
            notify(publish ? '布局已发布，可用于创建课程场次' : '布局草稿已保存');
        }
        catch (e) {
            notify((e as Error).message);
        }
        finally {
            setBusy(false);
        }
    }
    const object = layout ? [...layout.elements, ...layout.seats].find(e => selected.includes(e.id)) : null;
    function point(event: React.PointerEvent<SVGSVGElement>) { const svg = svgRef.current!; const rect = svg.getBoundingClientRect(); return { x: (event.clientX - rect.left) * layout!.width / rect.width, y: (event.clientY - rect.top) * layout!.height / rect.height }; }
    return <><div className="toolbar layout-toolbar"><div className="inline-fields"><select aria-label="选择布局版本" value={layout?.id ?? ''} onChange={e => { if (dirty && !confirm('有未保存的修改，确认切换布局？'))
        return; setLayout(layouts.find(l => l.id === e.target.value) ?? null); setSelected([]); setDirty(false); }}>{layouts.map(l => <option key={l.id} value={l.id}>{l.name} · {l.status === 'PUBLISHED' ? '已发布' : '草稿'}</option>)}</select><button onClick={() => setCreate(true)}><Plus size={15}/>新布局</button><button onClick={() => setNewVenue(true)}><Plus size={15}/>场地</button></div><div className="inline-fields">{readonly ? <button className="primary" disabled={busy} onClick={async () => { if (!layout)
        return; setBusy(true); try {
        const result = await api<{
            layout: Layout;
        }>('layouts', 'POST', { name: `${layout.name} · 新版本`, venueId: layout.venueId, cloneId: layout.id });
        await load(result.layout.id);
        notify('已复制为新草稿');
    }
    catch (e) {
        notify((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}><Copy size={15}/>复制为新版本</button> : <><button disabled={!layout || busy} onClick={() => save()}><Save size={15}/>保存{dirty ? ' *' : ''}</button><button className="primary" disabled={!layout || busy} onClick={() => { if (confirm('发布后此版本不可修改。确认保存并发布？'))
        save(true); }}><Send size={15}/>保存并发布</button></>}</div></div>{error && <p role="alert" className="form-error">{error}</p>}{layout ? <div className="editor-shell"><div className="editor-tools"><span className="badge green">{readonly ? '已发布 · 只读' : '草稿 · 可编辑'}</span><span className="muted small">{layout.venue.name} · {layout.seats.length} 个座位</span>{!readonly && <><button onClick={() => { const e: Element = { id: makeId(), kind: 'DESK', label: '共享长桌', x: 160, y: 180, width: 240, height: 90, rotation: 0 }; change({ ...layout, elements: [...layout.elements, e] }); setSelected([e.id]); }}><Square size={16}/>桌子</button><button onClick={() => { const e: Element = { id: makeId(), kind: 'BOOTH', label: '独立卡位', x: 160, y: 180, width: 130, height: 90, rotation: 0 }; change({ ...layout, elements: [...layout.elements, e] }); setSelected([e.id]); }}><PanelIcon />卡位</button><button onClick={() => { const e: Element = { id: makeId(), kind: 'DIVIDER', label: '', x: 180, y: 180, width: 250, height: 12, rotation: 0 }; change({ ...layout, elements: [...layout.elements, e] }); setSelected([e.id]); }}><Minus size={16}/>分隔物</button><button onClick={() => { const e: Element = { id: makeId(), kind: 'LABEL', label: '教学区', x: 300, y: 80, width: 180, height: 36, rotation: 0 }; change({ ...layout, elements: [...layout.elements, e] }); setSelected([e.id]); }}>T 文字</button><button onClick={() => { let code = ''; let i = layout.seats.length + 1; do {
            code = `A${String(i++).padStart(2, '0')}`;
        } while (layout.seats.some(s => s.code === code)); const parent = layout.elements.find(e => selected.includes(e.id)); const s: Seat = { id: makeId(), code, x: parent?.x ?? 180, y: Math.min(layout.height - 60, (parent?.y ?? 120) + (parent?.height ?? 0) + 12), rotation: 0, enabled: true, elementId: parent?.id ?? null }; change({ ...layout, seats: [...layout.seats, s] }); setSelected([s.id]); }}><Armchair size={16}/>座位</button></>}<div className="zoom-tools"><button aria-label="缩小画布" onClick={() => setZoom(z => Math.max(0.5, z - 0.1))}><ZoomOut size={16}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大画布" onClick={() => setZoom(z => Math.min(2, z + 0.1))}><ZoomIn size={16}/></button></div></div><div className="editor-grid"><div className="editor-canvas-wrap"><svg ref={svgRef} className="editor-canvas" viewBox={`0 0 ${layout.width} ${layout.height}`} style={{ width: `${zoom * 100}%`, minWidth: `${zoom * 600}px` }} aria-label="布局编辑画布" onPointerDown={e => { if (e.target === e.currentTarget)
            setSelected([]); }} onPointerMove={e => { if (!drag.current || readonly)
            return; const d = drag.current, p = point(e); const { dx, dy } = movement([d.shape, ...d.children], p.x - d.pointerX, p.y - d.pointerY, layout.width, layout.height); const x = d.x + dx, y = d.y + dy; change({ ...layout, elements: layout.elements.map(el => el.id === d.id ? { ...el, x, y } : el), seats: layout.seats.map(s => s.id === d.id ? { ...s, x, y } : d.children.some(c => c.id === s.id) ? { ...s, x: d.children.find(c => c.id === s.id)!.x + dx, y: d.children.find(c => c.id === s.id)!.y + dy } : s) }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <defs><pattern id="editor-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.8" fill="#d8dcd4"/></pattern></defs><rect width={layout.width} height={layout.height} fill="url(#editor-dots)" pointerEvents="none"/>{[...layout.elements, ...layout.seats].map(o => { const isSeat = 'code' in o; const w = isSeat ? 40 : o.width, h = isSeat ? 42 : o.height; return <g key={o.id} role="button" tabIndex={0} aria-label={isSeat ? `编辑座位 ${o.code}` : `编辑元素 ${o.label || o.kind}`} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setSelected([o.id]);
        } if (!readonly && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
            e.preventDefault();
            updateObject(o.id, { x: Math.max(0, Math.min(layout.width - w, o.x + (e.key === 'ArrowLeft' ? -5 : e.key === 'ArrowRight' ? 5 : 0))), y: Math.max(0, Math.min(layout.height - h, o.y + (e.key === 'ArrowUp' ? -5 : e.key === 'ArrowDown' ? 5 : 0))) });
        } }} transform={`translate(${o.x} ${o.y}) rotate(${o.rotation} ${w / 2} ${h / 2})`} style={{ cursor: readonly ? 'pointer' : 'move' }} onPointerDown={e => { e.stopPropagation(); if (e.shiftKey) {
            setSelected(v => v.includes(o.id) ? v.filter(id => id !== o.id) : [...v, o.id]);
            return;
        } setSelected([o.id]); if (readonly)
            return; const p = point(e as unknown as React.PointerEvent<SVGSVGElement>); svgRef.current?.setPointerCapture(e.pointerId); drag.current = { id: o.id, pointerX: p.x, pointerY: p.y, x: o.x, y: o.y, shape: { ...o }, children: layout.seats.filter(s => s.elementId === o.id).map(s => ({ ...s })) }; }}><rect width={w} height={h} rx={isSeat ? 7 : 6} fill={isSeat ? o.enabled ? '#f6faef' : '#e4e5e0' : o.kind === 'DIVIDER' ? '#c8cebe' : '#eee9df'} stroke={selected.includes(o.id) ? '#708453' : isSeat ? '#aab99a' : '#d6d0c4'} strokeWidth={selected.includes(o.id) ? 3 : 1.5} strokeDasharray={selected.includes(o.id) ? '5 2' : undefined}/><text x={w / 2} y={h / 2 + 5} textAnchor="middle" fontSize={isSeat ? 12 : 14} fill="#666f5b" pointerEvents="none">{isSeat ? o.code : o.label}</text></g>; })}</svg><p className="canvas-hint"><MousePointer2 size={13}/>拖拽调整位置 · Shift 多选座位 · 方向键微调 · 属性中缩放与旋转</p></div><aside className="editor-properties"><h3>布局属性</h3><label>版本名称<input disabled={readonly} value={layout.name} onChange={e => change({ ...layout, name: e.target.value })}/></label><div className="inline-fields"><label>画布宽<input disabled={readonly} type="number" min={400} max={2000} value={layout.width} onChange={e => change({ ...layout, width: Number(e.target.value) })}/></label><label>画布高<input disabled={readonly} type="number" min={300} max={2000} value={layout.height} onChange={e => change({ ...layout, height: Number(e.target.value) })}/></label></div><hr /><h3>选中元素 {selected.length > 1 ? `(${selected.length})` : ''}</h3>{object ? <><label>{'code' in object ? '座位编号' : '元素文字'}<input disabled={readonly} value={'code' in object ? object.code : object.label} onChange={e => updateObject(object.id, 'code' in object ? { code: e.target.value } : { label: e.target.value })}/></label><div className="inline-fields"><label>X<input disabled={readonly} type="number" min={0} value={object.x} onChange={e => updateObject(object.id, { x: Number(e.target.value) })}/></label><label>Y<input disabled={readonly} type="number" min={0} value={object.y} onChange={e => updateObject(object.id, { y: Number(e.target.value) })}/></label></div>{'width' in object && <div className="inline-fields"><label>宽度<input disabled={readonly} type="number" min={10} max={1000} value={object.width} onChange={e => updateObject(object.id, { width: Number(e.target.value) })}/></label><label>高度<input disabled={readonly} type="number" min={10} max={1000} value={object.height} onChange={e => updateObject(object.id, { height: Number(e.target.value) })}/></label></div>}<label>旋转角度<input disabled={readonly} type="number" min={-360} max={360} value={object.rotation} onChange={e => updateObject(object.id, { rotation: Number(e.target.value) })}/></label>{'code' in object && <><label>所属桌面<select disabled={readonly} value={object.elementId ?? ''} onChange={e => updateObject(object.id, { elementId: e.target.value || null })}><option value="">独立座位</option>{layout.elements.filter(e => e.kind === 'DESK' || e.kind === 'BOOTH').map(e => <option key={e.id} value={e.id}>{e.label || e.kind}</option>)}</select></label><label className="check-label"><input disabled={readonly} type="checkbox" checked={object.enabled} onChange={e => updateObject(object.id, { enabled: e.target.checked })}/>座位启用</label></>}{!readonly && <div className="inline-fields"><button onClick={() => updateObject(object.id, { rotation: (object.rotation + 90) % 360 })}><RotateCw size={14}/>旋转</button><button className="danger" onClick={() => { change({ ...layout, elements: layout.elements.filter(e => !selected.includes(e.id)), seats: layout.seats.filter(s => !selected.includes(s.id)).map(s => selected.includes(s.elementId ?? '') ? { ...s, elementId: null } : s) }); setSelected([]); }}><Trash2 size={14}/>删除</button></div>}</> : <p className="muted small">选择画布中的元素以编辑属性。</p>}{!readonly && <><hr /><h3>批量编号</h3><p className="muted small">按从上到下、从左到右编号。多选时仅编号选中座位。</p><div className="inline-fields"><label>前缀<input value={prefix} onChange={e => setPrefix(e.target.value)} maxLength={15}/></label><label>起始<input type="number" min={1} value={start} onChange={e => setStart(Number(e.target.value))}/></label></div><button onClick={() => { const selectedSeats = layout.seats.filter(s => selected.includes(s.id)); const targets = (selectedSeats.length ? selectedSeats : layout.seats).toSorted((a, b) => a.y - b.y || a.x - b.x); change({ ...layout, seats: layout.seats.map(s => targets.some(t => t.id === s.id) ? { ...s, code: `${prefix}${String(start + targets.findIndex(t => t.id === s.id)).padStart(2, '0')}` } : s) }); }}>批量编号 {layout.seats.filter(s => selected.includes(s.id)).length || layout.seats.length} 个座位</button></>}</aside></div></div> : <div className="empty-state"><PanelIcon /><h2>先创建一个空间布局</h2><p>添加桌子、卡位与座位，然后发布你的第一个版本。</p><button className="primary" onClick={() => setCreate(true)}>创建布局</button></div>}
    {(create || newVenue) && <Modal title={newVenue ? '新增场地' : '新建布局'} close={() => { if (!busy) { setCreate(false); setNewVenue(false); } }}><h2>{newVenue ? '新增教学场地' : '新建布局版本'}</h2><form className="form-grid" onSubmit={async (e) => { e.preventDefault(); const form = Object.fromEntries(new FormData(e.currentTarget)); setBusy(true); try {
        const result = await api<{
            layout?: Layout;
        }>(newVenue ? 'layouts/venues' : 'layouts', 'POST', form);
        await load(result.layout?.id);
        setCreate(false);
        setNewVenue(false);
        notify('创建成功');
    }
    catch (e) {
        notify((e as Error).message);
    }
    finally {
        setBusy(false);
    } }}><label>{newVenue ? '场地名称' : '布局名称'}<input name="name" required maxLength={80}/></label>{newVenue ? <label>位置说明<input name="location" required/></label> : <label>所属场地<select name="venueId" required>{venues.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>{!venues.length && <small>请先关闭此窗口，创建场地。</small>}</label>}<div className="modal-actions"><button type="button" onClick={() => { setCreate(false); setNewVenue(false); }}>取消</button><button className="primary" disabled={busy || (!newVenue && !venues.length)}>创建</button></div></form></Modal>}
  </>;
}
function PanelIcon() { return <span aria-hidden="true">▣</span>; }
