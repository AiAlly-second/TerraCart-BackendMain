const mongoose = require("mongoose");

const employeeSkillsMappingSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
      index: true,
    },
    skillId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployeeSkillsMaster",
      required: true,
      index: true,
    },
    proficiencyLevel: {
      type: String,
      enum: ["beginner", "intermediate", "advanced", "expert"],
      default: "intermediate",
    },
    certified: { type: Boolean, default: false },
    certifiedDate: { type: Date },
    notes: { type: String },
  },
  { timestamps: true }
);

// Compound index to prevent duplicate mappings
employeeSkillsMappingSchema.index({ employeeId: 1, skillId: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeSkillsMapping", employeeSkillsMappingSchema);













