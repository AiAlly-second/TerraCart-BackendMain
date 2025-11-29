# Quick MongoDB Atlas Setup (5 Minutes)

## 🚀 Quick Steps

### 1. Create Account & Cluster
- Go to: https://www.mongodb.com/cloud/atlas/register
- Sign up (free)
- Create **M0 FREE** cluster
- Wait 3-5 minutes for cluster creation

### 2. Setup Security
- **Database Access**: Create user (username + password)
- **Network Access**: Click "Add Current IP Address"

### 3. Get Connection String
- Click **"Connect"** → **"Connect your application"**
- Copy connection string
- Replace `<username>` and `<password>` with your credentials
- Add database name: `/terra-cart` before `?`

Example:
```
mongodb+srv://admin:MyPassword123@cluster0.abc123.mongodb.net/terra-cart?retryWrites=true&w=majority
```

### 4. Update Your App

**Create `.env` file in `backend` folder:**

```env
MONGO_URI=mongodb+srv://admin:yourpassword@cluster0.xxxxx.mongodb.net/terra-cart?retryWrites=true&w=majority
PORT=5001
JWT_SECRET=your-secret-key-here
```

### 5. Test Connection

```bash
cd backend
npm start
```

You should see:
```
🌐 Connecting to MongoDB Atlas (Cloud)...
✅ MongoDB Connected: Atlas Cluster: cluster0-shard-00-00.xxxxx.mongodb.net
📊 Database: terra-cart
```

## ✅ Done!

Your database is now on MongoDB Atlas cloud. 

**For detailed instructions, see:** `MONGODB_ATLAS_SETUP.md`















