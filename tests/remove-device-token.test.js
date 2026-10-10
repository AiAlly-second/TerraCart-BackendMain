const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createRemoveDeviceToken}=require('../controllers/removeDeviceToken');
async function request(t,body,fail=false,authenticated=true){
  const writes=[];const userWrites=[];const app=express();app.use(express.json());
  app.post('/remove-token',(req,res,next)=>{if(!authenticated)return res.sendStatus(401);req.user={_id:'qa-user-a'};next();},createRemoveDeviceToken({updateOne:async(...args)=>{writes.push(args);if(fail)throw Error('private');}}, {updateOne:async(...args)=>userWrites.push(args)}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/remove-token`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({registrationId:'11111111-1111-4111-8111-111111111111',...body})});return {response,writes,userWrites};
}
test('cleanup matches exact token and authenticated owner, ignoring supplied user ID',async t=>{
 const {response,writes,userWrites}=await request(t,{token:'qa-device-token',userId:'qa-user-b'});assert.equal(response.status,200);
 assert.equal(userWrites[0][0].fcmTokenRegistrationId,'11111111-1111-4111-8111-111111111111');
 assert.deepEqual(writes,[[{token:'qa-device-token',userId:'qa-user-a','metadata.mobileRegistrationId':'11111111-1111-4111-8111-111111111111'},{$set:{isActive:false}}]]);
});
test('no token is changed without authentication',async t=>{const {response,writes}=await request(t,{token:'qa-token'},false,false);assert.equal(response.status,401);assert.equal(writes.length,0);});
test('invalid token rejected before database',async t=>{const {response,writes}=await request(t,{token:{secret:'invalid'}});assert.equal(response.status,400);assert.equal(writes.length,0);});
test('database failure has safe retryable response',async t=>{const {response}=await request(t,{token:'qa-token'},true);assert.equal(response.status,503);assert.equal((await response.text()).includes('private'),false);});
