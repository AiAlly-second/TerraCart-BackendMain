const mongoose = require("mongoose");

const employeeSkillsMasterSchema = new mongoose.Schema(
  {
    skillName: { type: String, required: true, unique: true },
    description: { type: String },
    category: {
      type: String,
      enum: ["culinary", "service", "management", "technical", "language", "other"],
      default: "other",
    },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmployeeSkillsMaster", employeeSkillsMasterSchema);













