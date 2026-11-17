'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeRobot, normalizeRooms } = require('./normalize');

test('the real Saros camelCase telemetry updates time, area, custom power and tank warning', () => {
  const robot = normalizeRobot({ state: 8, battery: 100, cleanTime: 1021, cleanArea: 8245000, fanPower: 106, errorCode: 0, dockErrorStatus: 38, inCleaning: 0 }, null, 1234);
  assert.equal(robot.cleanTimeSeconds, 1021);
  assert.equal(robot.cleanAreaM2, 8.245);
  assert.equal(robot.fanLabel, 'Personalizado');
  assert.equal(robot.updatedAt, 1234);
  assert.equal(robot.alerts[0].id, 'clean-water-empty');
  assert.equal(robot.label, 'Na base · carregado');
});

test('water warning survives omitted data and another error, then clears on confirmed dock OK', () => {
  const warning = normalizeRobot({ state: 8, dockErrorStatus: 38 });
  const missing = normalizeRobot({ state: 8 }, warning);
  assert.equal(missing.alerts[0].id, 'clean-water-empty');
  const unknown = normalizeRobot({ state: 8, dockErrorStatus: 999 }, missing);
  assert.equal(unknown.alerts.length, 2);
  assert.equal(unknown.alerts[1].id, 'dock-error-999');
  const resolved = normalizeRobot({ state: 8, dockErrorStatus: 0 }, unknown);
  assert.deepEqual(resolved.alerts, []);
});

test('unknown states and errors remain explicit instead of becoming OK', () => {
  const robot = normalizeRobot({ state: 471, error_code: 888, dock_error_status: 999, clean_time: 20, fan_power: 104 });
  assert.equal(robot.state, 'unknown');
  assert.equal(robot.label, 'Estado 471');
  assert.equal(robot.errorCode, 888);
  assert.equal(robot.cleanTimeSeconds, 20);
  assert.equal(robot.alerts.length, 2);
  assert.throws(() => normalizeRobot({ error: 'Sem resposta' }));
});

test('real room IDs get their names from map metadata instead of undefined rawName', () => {
  const rooms = normalizeRooms({ rooms: [{ segmentId: 2, iotId: 'ignored' }, { segmentId: 3 }] }, { mapInfo: [{ rooms: [{ id: 2, iotName: 'Sala de estar' }, { id: 3, iotName: 'Cozinha' }] }] });
  assert.deepEqual(rooms, [{ id: 2, name: 'Sala de estar' }, { id: 3, name: 'Cozinha' }]);
});

test('installed-version states distinguish idle, charger loss, manual control and Saros mop operations', () => {
  const examples = [
    [2, 'charger_disconnected'], [3, 'idle'], [4, 'remote_control'],
    [25, 'washing_mops'], [33, 'attaching_mops'], [34, 'detaching_mops'],
    [202, 'stopping_drying'], [6305, 'room_clean_then_mop_vacuuming'],
    [6306, 'room_clean_then_mop_mopping'], [6310, 'returning_to_wash']
  ];
  for (const [code, state] of examples) assert.equal(normalizeRobot({ state: code }).state, state);
  assert.equal(normalizeRobot({ state: 101 }).online, false);
});
