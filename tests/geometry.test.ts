import test from 'node:test';
import assert from 'node:assert/strict';
import { bounds, insideCanvas, movement, snapMovement } from '../src/lib/geometry.ts';

test('家具与座位完整尺寸必须留在画布内，允许边缘重合', () => {
    assert.equal(insideCanvas({ x: 300, y: 200, width: 100, height: 100, rotation: 0 }, 400, 300), true);
    assert.equal(insideCanvas({ x: 301, y: 200, width: 100, height: 100, rotation: 0 }, 400, 300), false);
    assert.equal(insideCanvas({ x: 360, y: 258, rotation: 0 }, 400, 300), true);
    assert.equal(insideCanvas({ x: 360, y: 259, rotation: 0 }, 400, 300), false);
});
test('旋转后的外接范围越界也拒绝，直角浮点误差不误拒边界', () => {
    assert.equal(insideCanvas({ x: 0, y: 0, width: 100, height: 100, rotation: 45 }, 400, 300), false);
    assert.equal(insideCanvas({ x: 0, y: 0, width: 100, height: 100, rotation: 90 }, 400, 300), true);
    assert.equal(insideCanvas({ x: 50, y: 50, width: 100, height: 100, rotation: -45 }, 400, 300), true);
});
test('桌面连同座位拖动时整体限位，保留桌椅相对位置', () => {
    const shapes = [{ x: 100, y: 100, width: 200, height: 80, rotation: 0 }, { x: 280, y: 200, rotation: 0 }];
    assert.deepEqual(movement(shapes, 300, 300, 400, 300), { dx: 80, dy: 58 });
    assert.deepEqual(movement(shapes, -300, -300, 400, 300), { dx: -100, dy: -100 });
});
test('长桌旋转后的外接范围决定拖动边界', () => {
    const desk = { x: 100, y: 100, width: 200, height: 80, rotation: 90 };
    const box = bounds(desk);
    assert.ok(Math.abs(box.left - 160) < 1e-7);
    assert.ok(Math.abs(box.top - 40) < 1e-7);
    assert.deepEqual(movement([desk], 500, 500, 400, 300), { dx: 160, dy: 60 });
    assert.deepEqual(movement([desk], -500, -500, 400, 300), { dx: -160, dy: -40 });
});
test('拖动吸附最近桌椅边缘，超过阈值或没有目标时不吸附', () => {
    const moving = [{ x: 10, y: 10, width: 40, height: 40, rotation: 0 }];
    const targets = [{ x: 100, y: 100, width: 40, height: 40, rotation: 0 }];
    assert.deepEqual(snapMovement(moving, targets, 45, 45, 400, 300), { dx: 50, dy: 50, guideX: 100, guideY: 100 });
    assert.deepEqual(snapMovement(moving, targets, 45, 45, 400, 300, 4), { dx: 45, dy: 45, guideX: undefined, guideY: undefined });
    assert.deepEqual(snapMovement(moving, [], 500, 500, 400, 300), { dx: 350, dy: 250, guideX: undefined, guideY: undefined });
});
