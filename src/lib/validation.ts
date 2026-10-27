import { z } from 'zod';
import { insideCanvas } from './geometry';
export const id = z.string().min(1).max(100);
export const email = z.string().trim().email().max(200).transform(v => v.toLowerCase());
export const studentId = z.string().trim().min(3, '学号至少需要 3 位').max(30).regex(/^[a-zA-Z0-9]+$/, '学号只能包含字母和数字').transform(v => v.toLowerCase());
export const password = z.string().min(10, '密码至少需要 10 位').max(100);
const minute = z.number().int().min(0).max(1440);
const windowFields = { startMinute: minute, endMinute: minute };
const weeklyRule = z.object({ weekday: z.number().int().min(0).max(6), ...windowFields }).refine(v => v.startMinute < v.endMinute, '结束时间必须晚于开始时间');
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, '日期无效');
const dateRule = z.object({ date: dateString, allowed: z.boolean(), ...windowFields }).refine(v => v.startMinute < v.endMinute, '结束时间必须晚于开始时间');
export const groupSchema = z.object({ name: z.string().trim().min(1).max(80), canReserve: z.boolean(), isDefault: z.boolean().optional(), weeklyRules: z.array(weeklyRule).max(100), dateRules: z.array(dateRule).max(200) });
const position = z.number().finite().min(0).max(2000);
export const layoutSchema = z.object({
    name: z.string().trim().min(1).max(100), width: z.number().int().min(400).max(2000), height: z.number().int().min(300).max(2000),
    elements: z.array(z.object({ id, kind: z.enum(['DESK', 'BOOTH', 'DIVIDER', 'LABEL']), label: z.string().max(50), x: position, y: position, width: z.number().min(10).max(1000), height: z.number().min(10).max(1000), rotation: z.number().min(-360).max(360) })).max(200),
    seats: z.array(z.object({ id, originId: id.nullable().optional(), code: z.string().trim().min(1).max(30), x: position, y: position, rotation: z.number().min(-360).max(360), enabled: z.boolean(), fixedForAssistant: z.boolean().optional().default(false), elementId: id.nullable().optional() })).max(500),
}).superRefine((v, ctx) => {
    if (new Set(v.seats.map(s => s.code)).size !== v.seats.length)
        ctx.addIssue({ code: 'custom', message: '座位编号不能重复' });
    if (new Set([...v.seats, ...v.elements].map(s => s.id)).size !== v.seats.length + v.elements.length)
        ctx.addIssue({ code: 'custom', message: '元素标识不能重复' });
    if (v.seats.some(s => s.elementId && !v.elements.some(e => e.id === s.elementId && (e.kind === 'DESK' || e.kind === 'BOOTH'))))
        ctx.addIssue({ code: 'custom', message: '座位所属桌面不在此布局' });
    if ([...v.elements, ...v.seats].some(e => !insideCanvas(e, v.width, v.height)))
        ctx.addIssue({ code: 'custom', message: '元素尺寸或旋转后范围超出画布' });
});
export const courseSchema = z.object({ name: z.string().trim().min(1).max(100), instructor: z.string().trim().min(1).max(80), description: z.string().max(1000).default('') });
export const sessionSchema = z.object({ courseId: id.optional(), layoutId: id, startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), requiredAssistants: z.number().int().min(1).max(30).default(1), open: z.boolean() }).refine(v => Date.parse(v.endsAt) > Date.parse(v.startsAt), '结束时间必须晚于开始时间').refine(v => Date.parse(v.endsAt) - Date.parse(v.startsAt) <= 86400000, '时长不能超过 24 小时');
