const {test} = require('node:test');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const time = require('../utils/businessTime');
const {attendanceDurations} = require('../utils/attendanceDuration');

test('IST examples, date-only values and invalid dates', () => {
  assert.equal(time.getBusinessDateKey('2026-10-03T11:34:00Z'), '2026-10-03');
  assert.equal(time.getBusinessDateKey('2026-10-02T23:45:00Z'), '2026-10-03');
  assert.equal(time.getBusinessDateKey('2026-10-03'), '2026-10-03');
  assert.equal(time.businessDateTime('2026-10-03','17:04').toISOString(),'2026-10-03T11:34:00.000Z');
  assert.equal(time.validateDateKey('2026-02-30'), false);
  assert.throws(()=>time.parseServerTimestamp('2026-10-03'));
});
for (const TZ of ['UTC','Asia/Kolkata','America/Los_Angeles']) {
  test(`business boundaries and scheduler ignore host TZ=${TZ}`, () => {
    const result = JSON.parse(execFileSync(process.execPath, ['-e', `
      const t=require('./utils/businessTime'); const s=require('./utils/istDateTime');
      const r=t.businessDayQueryRange('2026-10-03');
      const backup=require('./services/backupRestore/backupScheduleUtils');
      console.log(JSON.stringify({start:r.startUTC,end:r.endUTC,date:s.formatISTDateKey('2026-10-02T23:45:00Z'),
        next:backup.computeNextRunAt({scheduleTimeIST:'00:00'},new Date('2026-10-03T11:34:00Z'))}));
    `],{cwd:require('node:path').resolve(__dirname,'..'),env:{...process.env,TZ},encoding:'utf8'}));
    assert.deepEqual(result, {start:'2026-10-02T18:30:00.000Z',end:'2026-10-03T18:30:00.000Z',date:'2026-10-03',next:'2026-10-03T18:30:00.000Z'});
  });
}
test('attendance key takes priority over historically misaligned date storage',()=>{
  assert.equal(time.attendanceDateKey({date:'2026-09-30T13:00:00Z', attendanceDateIST:'2026-10-01', checkIn:{time:'2026-10-01T09:46:00Z'}}),'2026-10-01');
});
test('working duration freezes on break, resumes, multiple breaks and checkout freeze',()=>{
  const stamp = hm => time.businessDateTime('2026-10-03',hm);
  const row = {checkIn:{time:stamp('17:04')},breakStart:stamp('17:10'),isOnBreak:true,breaks:[]};
  assert.equal(attendanceDurations(row,stamp('17:15')).workingMs,6*60000);
  assert.equal(attendanceDurations(row,stamp('17:15')).activeBreakMs,5*60000);
  row.breaks=[{breakStart:stamp('17:10'),breakEnd:stamp('17:15'),durationMinutes:5}];row.breakDuration=5;row.breakStart=null;row.isOnBreak=false;
  assert.equal(attendanceDurations(row,stamp('17:20')).workingMs,11*60000);
  row.breaks=[{breakStart:stamp('17:20'),breakEnd:stamp('17:30'),durationMinutes:10},{breakStart:stamp('18:00'),breakEnd:stamp('18:15'),durationMinutes:15}];row.breakDuration=25;
  assert.equal(attendanceDurations(row,stamp('19:00')).workingMs,91*60000);
  row.checkOut={time:stamp('19:00')};assert.equal(attendanceDurations(row,stamp('20:00')).workingMs,91*60000);
});
