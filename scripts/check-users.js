const mongoose = require('mongoose');
const User = require('./models/userModel');

mongoose.connect('mongodb://127.0.0.1:27017/terracart')
  .then(async () => {
    try {
      const users = await User.find({});
      console.log('\nCurrent users in database:');
      users.forEach(user => {
        console.log(`\nName: ${user.name}`);
        console.log(`Email: ${user.email}`);
        console.log(`Role: ${user.role}`);
        console.log(`Password hash: ${user.password.substring(0, 20)}...`);
      });
    } catch (error) {
      console.error('Error:', error);
    } finally {
      mongoose.connection.close();
    }
  });