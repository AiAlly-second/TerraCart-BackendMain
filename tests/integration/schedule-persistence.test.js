const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
process.env.NODE_ENV = 'test';
const { startIsolatedMongo } = require('../helpers/isolatedMongo');
const Employee = require('../../models/employeeModel');
const Schedule = require('../../models/employeeScheduleModel');
const controller = require('../../controllers/employeeScheduleController');
const { getMe, loginUser } = require('../../controllers/userController');
const User = require('../../models/userModel');
let mongo, server, actor;
const fixtures = {}, events = [];
const cart = new mongoose.Types.ObjectId(), franchise = new mongoose.Types.ObjectId();
const week = [{day: 'sunday', isWorking: true, startTime: '09:00', endTime: '17:00'}];
const api = async (method, path, body) => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: {'content-type':'application/json', 'x-app-login':'mobile'},
    ...(body ? {body: JSON.stringify(body)} : {})});
  return {status: response.status, body: await response.json()};
};
before(async () => {
  process.env.JWT_SECRET = 'schedule-isolated-fixture-secret';
  mongo = await startIsolatedMongo();
  await Schedule.init();
  for (const role of ['manager', 'captain', 'waiter', 'cook']) {
    const id = new mongoose.Types.ObjectId(), employeeId = new mongoose.Types.ObjectId();
    fixtures[role] = {_id:id, employeeId, role, email:`schedule-${role}@test.invalid`};
    await Employee.collection.insertOne({_id:employeeId, userId:id, name:'Fixture',
      email:fixtures[role].email, employeeRole:role, cartId:cart, franchiseId:franchise,
      disability:{hasDisability:role === 'waiter', type:'fixture-private-type'}, isActive:true});
  }
  actor = fixtures.manager;
  const app = express(); app.use(express.json()); app.use((req,res,next) => {req.user=actor;next();});
  app.set('io', {}); app.set('emitToCafe', (_,room,event) => events.push({room,event}));
  app.get('/my', controller.getMySchedule); app.get('/web', controller.getAllSchedules);
  app.post('/schedule', controller.upsertSchedule); app.get('/me', getMe); app.post('/login', loginUser);
  server=app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening',resolve));
});
after(async () => { if(server) await new Promise(resolve => server.close(resolve)); await mongoose.disconnect(); if(mongo) await mongo.stop(); });

for (const role of ['manager','captain','waiter','cook']) {
  test(`${role}: create, update and reopen persist in same record visible to web`, async () => {
    actor = fixtures[role];
    const own = String(actor.employeeId);
    const first = await api('POST','/schedule',{employeeId:own, weeklySchedule:week});
    assert.equal(first.status,200,JSON.stringify(first.body));
    const updatedWeek=[{...week[0],startTime:'10:00',endTime:'18:00'}];
    const edited=await api('POST','/schedule',{employeeId:own,weeklySchedule:updatedWeek});
    assert.equal(edited.status,200); assert.equal(edited.body._id,first.body._id);
    const reopened=await api('GET','/my'); assert.deepEqual(reopened.body.weeklySchedule,updatedWeek);
    assert.equal(await Schedule.countDocuments({employeeId:own}),1);
    actor={_id:cart,role:'admin'};
    const web=await api('GET','/web');
    assert.deepEqual(web.body.find(row=>row.employeeId._id===own).weeklySchedule,updatedWeek);
    const webEdit=await api('POST','/schedule',{employeeId:own,weeklySchedule:week});assert.equal(webEdit.status,200);
    actor=fixtures[role];assert.deepEqual((await api('GET','/my')).body.weeklySchedule,week);
  });
}
test('concurrent initial reads and duplicate saves produce one record', async () => {
  actor=fixtures.cook;await Schedule.deleteMany({employeeId:actor.employeeId});
  const results=await Promise.all([api('GET','/my'),api('GET','/my'),
    api('POST','/schedule',{employeeId:String(actor.employeeId),weeklySchedule:week}),
    api('POST','/schedule',{employeeId:String(actor.employeeId),weeklySchedule:week})]);
  assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
  assert.equal(await Schedule.countDocuments({employeeId:actor.employeeId}),1);
  assert.deepEqual((await api('GET','/my')).body.weeklySchedule,week);
});
test('invalid payloads do not change persisted schedule', async () => {
  actor=fixtures.waiter; const employeeId=String(actor.employeeId);
  const before=(await Schedule.findOne({employeeId})).toObject();
  for (const body of [{weeklySchedule:week}, {employeeId:'bad',weeklySchedule:week},
    {employeeId,weeklySchedule:[week[0],week[0]]},
    ...[['25:00','17:00'],['17:00','09:00'],['09:00','09:00']].map(([startTime,endTime])=>({employeeId,weeklySchedule:[{...week[0],startTime,endTime}]}))]) {
    assert.equal((await api('POST','/schedule',body)).status,400);
  }
  assert.deepEqual((await Schedule.findOne({employeeId})).weeklySchedule.toObject(),before.weeklySchedule);
});
test('self-only and outlet boundaries hold; hierarchy cannot be overridden', async () => {
  actor=fixtures.waiter;
  assert.equal((await api('POST','/schedule',{employeeId:String(fixtures.cook.employeeId),weeklySchedule:week})).status,403);
  actor=fixtures.manager;
  const foreign=new mongoose.Types.ObjectId();
  await Employee.collection.insertOne({_id:foreign,name:'Other outlet',cartId:new mongoose.Types.ObjectId(),employeeRole:'waiter'});
  assert.equal((await api('POST','/schedule',{employeeId:String(foreign),weeklySchedule:week})).status,404);
  const saved=await api('POST','/schedule',{employeeId:String(actor.employeeId),weeklySchedule:week,
    cartId:String(foreign),franchiseId:String(foreign),_id:String(foreign)});
  assert.equal(saved.status,200);assert.equal(saved.body.cartId,String(cart));assert.equal(saved.body.franchiseId,String(franchise));
  assert.ok(events.some(e=>e.room===String(cart)&&e.event==='schedule:updated'));
});
test('me and login expose only the canonical disability boolean for staff', async () => {
  for (const role of ['waiter','cook']) {
    actor=fixtures[role];
    const result=await api('GET','/me');assert.equal(result.status,200);
    assert.equal(result.body.user.hasDisability,role==='waiter');assert.equal(result.body.user.disability,undefined);
    await User.create({...actor,name:'Fixture',password:'fixture-pass-123',cafeId:cart});
    const login=await api('POST','/login',{email:actor.email,password:'fixture-pass-123'});
    assert.equal(login.status,200,JSON.stringify(login.body));
    assert.equal(login.body.user.hasDisability,role==='waiter');assert.equal(login.body.user.role,role);
    assert.equal(login.body.user.disability,undefined);
  }
});
