process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = require('node:crypto').randomBytes(32).toString('hex');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { startIsolatedMongo } = require('../helpers/isolatedMongo');
const User = require('../../models/userModel');
const DeviceToken = require('../../models/deviceTokenModel');
const routes = require('../../routes/notificationRoutes');

test('real HTTP/JWT/Mongo device registration isolation and retry', async t => {
  const db = await startIsolatedMongo();
  t.after(async () => { await mongoose.disconnect(); await db.stop(); });
  const app = express(); app.use(express.json({limit:'16kb'})); app.use('/api',routes);
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const cartA = new mongoose.Types.ObjectId(), cartB = new mongoose.Types.ObjectId();
  const users = await User.create([
    {name:'QA A',email:'qa-a@example.invalid',password:'test-only',role:'waiter',cafeId:cartA,employeeId:new mongoose.Types.ObjectId()},
    {name:'QA B',email:'qa-b@example.invalid',password:'test-only',role:'cook',cafeId:cartB,employeeId:new mongoose.Types.ObjectId()},
  ]);
  const [a,b] = users;
  const session = user => jwt.sign({id:String(user._id),tokenVersion:0},process.env.JWT_SECRET,{expiresIn:'10m'});
  const post = (endpoint, body, user=a) => fetch(`http://127.0.0.1:${server.address().port}/api/${endpoint}`, {
    method:'POST', headers:{'Content-Type':'application/json',...(user ? {Authorization:`Bearer ${session(user)}`} : {})},body:JSON.stringify(body)});
  const registrationId='11111111-1111-4111-8111-111111111111';
  const secondId='22222222-2222-4222-8222-222222222222';
  const deviceA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const deviceB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const register = (user, token, id, device) => post('save-token', {userId:String(user._id), firebaseToken:token,
    platform:'android',metadata:{mobileRegistrationId:id,mobileDeviceId:device}},user);
  await t.test('requires real auth, validates payload and refuses another user/cart',async()=>{
    assert.equal((await post('save-token',{userId:String(a._id),firebaseToken:'qa-token'},null)).status,401);
    assert.equal((await post('save-token',{userId:String(b._id),firebaseToken:'qa-token'})).status,403);
    assert.equal((await post('save-token',{userId:String(a._id),firebaseToken:{bad:true}})).status,400);
    assert.equal((await post('save-token',{userId:String(a._id),firebaseToken:'qa-token',cartId:String(cartB)})).status,403);
    assert.equal((await post('remove-token',{token:'qa-token',registrationId},null)).status,401);
  });
  await t.test('multiple devices remain active; rotation retires only its device',async()=>{
    assert.equal((await register(a,'qa-device-a',registrationId,deviceA)).status,200);
    assert.equal((await register(a,'qa-device-b',secondId,deviceB)).status,200);
    assert.equal(await DeviceToken.countDocuments({userId:a._id,isActive:true}),2);
    assert.equal((await register(a,'qa-device-a-new',registrationId,deviceA)).status,200);
    assert.equal((await DeviceToken.findOne({token:'qa-device-a'})).isActive,false);
    assert.equal((await DeviceToken.findOne({token:'qa-device-b'})).isActive,true);
  });
  await t.test('cleanup is idempotent and leaves other devices unchanged',async()=>{
    for(let i=0;i<2;i++) assert.equal((await post('remove-token',{token:'qa-device-a-new',registrationId})).status,200);
    assert.equal((await DeviceToken.findOne({token:'qa-device-b'})).isActive,true);
    assert.equal((await DeviceToken.findOne({token:'qa-device-a-new'})).isActive,false);
  });
  await t.test('delayed cleanup cannot delete reassigned user or new registration',async()=>{
    assert.equal((await register(b,'qa-device-b',registrationId,deviceB)).status,200);
    assert.equal((await post('remove-token',{token:'qa-device-b',registrationId:secondId})).status,200);
    assert.equal((await DeviceToken.findOne({token:'qa-device-b'})).isActive,true);
    assert.equal((await DeviceToken.findOne({token:'qa-device-b'})).userId.toString(),String(b._id));
    assert.equal((await User.findById(a._id)).fcmToken,null);
    assert.equal((await User.findById(b._id)).fcmToken,'qa-device-b');
  });
});
