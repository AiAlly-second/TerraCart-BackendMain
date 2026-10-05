const {test,before,after} = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mongoose = require('mongoose');
const {startIsolatedMongo} = require('../helpers/isolatedMongo');
process.env.NODE_ENV='test';
const Attendance=require('../../models/employeeAttendanceModel');
const Employee=require('../../models/employeeModel');
const Schedule=require('../../models/employeeScheduleModel');
const Task=require('../../models/taskModel');
const User=require('../../models/userModel');
const time=require('../../utils/businessTime');
const attendance=require('../../controllers/attendanceController');
const task=require('../../controllers/taskController');
const schedule=require('../../controllers/employeeScheduleController');
let mongo,server,user,employee,cart,id; const events=[];
const api=async(method,path,body)=>{
  const res=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:res.status,body:await res.json()};
};
before(async()=>{
  mongo=await startIsolatedMongo();cart=new mongoose.Types.ObjectId();employee=new mongoose.Types.ObjectId();
  user={_id:new mongoose.Types.ObjectId(),role:'manager',name:'Tushar',email:'work-manager@test.invalid',employeeId:employee};
  await User.collection.insertOne(user);await Employee.collection.insertOne({_id:employee,name:'Tushar',email:user.email,userId:user._id,employeeRole:'manager',cartId:cart,isActive:true,autoCheckoutEnabled:true});
  const day=time.getBusinessDayName();await Schedule.create({employeeId:employee,cartId:cart,weeklySchedule:[{day,startTime:'00:00',endTime:'23:59',isWorking:true}]});
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=user;next();});
  app.set('io',{});app.set('emitToCafe',(_,room,event)=>events.push({room,event}));
  app.post('/checkin',attendance.checkIn);app.get('/today',attendance.getTodayAttendance);app.get('/history',attendance.getAllAttendance);
  app.patch('/:id/start-break',attendance.startBreak);app.patch('/:id/end-break',attendance.endBreak);app.patch('/:id/checkout',attendance.checkOutById);
  app.get('/tasks/today',task.getTodayTasks);app.get('/tasks',task.getAllTasks);app.post('/tasks/:id/complete',task.completeTask);
  app.get('/orders',require('../../controllers/orderController').getOrders);
  app.get('/payments',require('../../controllers/paymentController').listPayments);
  app.get('/schedule',schedule.getMySchedule);app.post('/schedule',schedule.upsertSchedule);
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await mongoose.disconnect();if(mongo)await mongo.stop();});
test('mobile and web share shift, checklist and schedule records; concurrent breaks are atomic',async()=>{
  const checkin=await api('POST','/checkin',{});assert.equal(checkin.status,200,JSON.stringify(checkin.body));id=checkin.body.attendance?._id||checkin.body.data?._id;assert.ok(id);
  const today=await api('GET','/today');assert.equal(today.status,200);assert.equal(today.body[0].attendanceDateIST,time.getBusinessDateKey());
  const defaultHistory=await api('GET','/history');
  assert.equal(defaultHistory.status,200,JSON.stringify(defaultHistory.body));
  assert.ok(defaultHistory.body.some(r=>r._id===id));
  const foreignEmployee=new mongoose.Types.ObjectId();
  const narrowed=await api('GET',`/history?employeeId=${foreignEmployee}&cartId=${cart}`);
  assert.equal(narrowed.status,200);assert.deepEqual(narrowed.body,[]);
  const starts=await Promise.all([api('PATCH',`/${id}/start-break`),api('PATCH',`/${id}/start-break`)]);
  assert.equal(starts.filter(r=>r.body.success===true).length,1,JSON.stringify(starts));
  const rejectCheckout=await api('PATCH',`/${id}/checkout`);assert.equal(rejectCheckout.body.success,false);
  const ends=await Promise.all([api('PATCH',`/${id}/end-break`),api('PATCH',`/${id}/end-break`)]);
  assert.equal(ends.filter(r=>r.body.success===true).length,1,JSON.stringify(ends));
  assert.equal((await Attendance.findById(id)).breaks.length,1);
  const created=await Task.create({title:'Opening checklist',assignedTo:employee,cartId:cart,dueDate:new Date(),category:'cleaning'});
  const mobile=await api('GET','/tasks/today');assert.equal(mobile.status,200);assert.ok(mobile.body.some(r=>r._id===String(created._id)));
  const completed=await api('POST',`/tasks/${created._id}/complete`);assert.equal(completed.status,200);assert.equal(completed.body.completedBy._id,String(employee));assert.ok(completed.body.completedAt);
  const web=await api('GET','/tasks');assert.equal(web.status,200);const tasks=Array.isArray(web.body)?web.body:web.body.data;assert.equal(tasks.find(r=>r._id===String(created._id)).status,'completed');
  const currentSchedule=await api('GET','/schedule');assert.equal(currentSchedule.status,200);
  const weeklySchedule=[{day:time.getBusinessDayName(),startTime:'09:00',endTime:'17:00',isWorking:true}];
  const saved=await api('POST','/schedule',{employeeId:String(employee),weeklySchedule});assert.equal(saved.status,200);
  assert.equal((await Schedule.findOne({employeeId:employee})).weeklySchedule[0].startTime,'09:00');
  const checkout=await api('PATCH',`/${id}/checkout`);assert.equal(checkout.body.success,true,JSON.stringify(checkout.body));
  const row=await Attendance.findById(id);assert.equal(row.isOnBreak,false);assert.equal(row.breakStart,null);
  assert.ok(events.some(e=>e.event==='attendance:break_ended'));assert.ok(events.some(e=>e.event==='task:completed'));assert.ok(events.some(e=>e.event==='schedule:updated'));
});
test('auto-close closes active break and preserves original attendance date',async()=>{
  const dateKey=time.dateKeyOffset(-1);const range=time.businessDayQueryRange(dateKey);
  const old=await Attendance.create({employeeId:employee,cartId:cart,date:range.startUTC,attendanceDateIST:dateKey,
    checkIn:{time:new Date(range.endUTC-3600000)},breakStart:new Date(range.endUTC-1800000),isOnBreak:true,attendanceStatus:'on_break',canTakeBreak:true});
  const {runAutoCheckoutForDate}=require('../../services/attendanceTaskSchedulerService');
  await runAutoCheckoutForDate({dateKey,range});const closed=await Attendance.findById(old._id);
  assert.equal(closed.attendanceDateIST,dateKey);assert.equal(closed.breaks.length,1);assert.ok(closed.breaks[0].breakEnd);assert.equal(closed.breakStart,null);assert.equal(closed.totalWorkingMinutes,30);
});

test('order and payment filters include a full Kolkata calendar day under host timezone',async()=>{
  const Order=require('../../models/orderModel'); const {Payment}=require('../../models/paymentModel');
  const keys=['2026-10-02T18:29:59.999Z','2026-10-02T18:30:00.000Z','2026-10-03T18:29:59.999Z','2026-10-03T18:30:00.000Z'];
  const ids=keys.map(()=>new mongoose.Types.ObjectId());
  await Order.collection.insertMany(keys.map((stamp,i)=>({_id:ids[i],cartId:cart,createdAt:new Date(stamp),updatedAt:new Date(stamp),status:'NEW',paymentStatus:'PENDING',orderType:'TAKEAWAY',serviceType:'TAKEAWAY',items:[],kotLines:[]})));
  await Payment.collection.insertMany(keys.map((stamp,i)=>({orderId:String(ids[i]),amount:100,status:'PENDING',method:'CASH',createdAt:new Date(stamp),metadata:{cartId:String(cart)}})));
  const orders=await api('GET','/orders?startDate=2026-10-03&endDate=2026-10-03');
  assert.equal(orders.status,200);assert.deepEqual(orders.body.map(r=>r._id).sort(),[String(ids[1]),String(ids[2])].sort());
  const payments=await api('GET','/payments?startDate=2026-10-03&endDate=2026-10-03');
  assert.equal(payments.status,200);assert.equal(payments.body.length,2,JSON.stringify(payments.body));
});

test('checkout supports legacy records without a Mongo version field',async()=>{
  const originalUser=user;
  const legacyEmployee=new mongoose.Types.ObjectId(), legacyId=new mongoose.Types.ObjectId();
  user={_id:new mongoose.Types.ObjectId(),role:'manager',email:'legacy-work-manager@test.invalid',employeeId:legacyEmployee};
  try {
    await Employee.collection.insertOne({_id:legacyEmployee,userId:user._id,email:user.email,cartId:cart,name:'Legacy manager',employeeRole:'manager',isActive:true});
    await Attendance.collection.insertOne({_id:legacyId,employeeId:legacyEmployee,cartId:cart,
      date:time.businessDayQueryRange().startUTC,attendanceDateIST:time.getBusinessDateKey(),
      checkIn:{time:new Date(Date.now()-60000)},attendanceStatus:'checked_in',isOnBreak:false,breakStart:null,breaks:[],breakDuration:0});
    const checkout=await api('PATCH',`/${legacyId}/checkout`);
    assert.equal(checkout.status,200,JSON.stringify(checkout.body));assert.equal(checkout.body.success,true);
    const row=await Attendance.findById(legacyId);assert.ok(row.checkOut.time);assert.equal(row.__v,1);
  } finally {user=originalUser;}
});

test('attendance history pagination preserves scope, stable order and legacy response shape',async()=>{
  const key='2026-09-01';
  const date=time.businessDayQueryRange(key).startUTC;
  const records=Array.from({length:7},(_,index)=> {
    const recordKey=time.dateKeyOffset(index,key), recordDate=time.businessDayQueryRange(recordKey).startUTC;
    return {_id:new mongoose.Types.ObjectId(),employeeId:employee,cartId:cart,date:recordDate,
      attendanceDateIST:recordKey,checkIn:{time:recordDate},createdAt:date};
  });
  await Attendance.collection.insertMany(records);
  const path=`/history?employeeId=${employee}&startDate=${key}&endDate=2026-09-07`;
  const legacy=await api('GET',path);
  assert.equal(legacy.status,200);assert.ok(Array.isArray(legacy.body));assert.equal(legacy.body.length,7);
  const first=await api('GET',`${path}&page=1&limit=3`);
  const second=await api('GET',`${path}&page=2&limit=3`);
  const last=await api('GET',`${path}&page=3&limit=3`);
  assert.equal(first.body.data.length,3);assert.equal(second.body.data.length,3);assert.equal(last.body.data.length,1);
  assert.equal(first.body.pagination.hasNextPage,true);assert.equal(last.body.pagination.hasNextPage,false);
  const ids=[...first.body.data,...second.body.data,...last.body.data].map(row=>row._id);
  assert.equal(new Set(ids).size,7);
  const foreign=await api('GET',`/history?employeeId=${new mongoose.Types.ObjectId()}&page=1&limit=3`);
  assert.deepEqual(foreign.body.data,[]);
  const invalid=await api('GET',`${path}&page=invalid&limit=-1`);
  assert.equal(invalid.body.pagination.page,1);assert.equal(invalid.body.pagination.limit,1);
});
