/** Cold-start demonstration thresholds, not ISO/vendor limits or validated failure probabilities. */
export const measurementSchema = {
  vibration_rms: {label:"振动 RMS",unit:"mm/s",min:0,max:200,warning:4.2,critical:7.1},
  bearing_temperature: {label:"轴承温度",unit:"degC",min:-50,max:250,warning:65,critical:85},
  motor_current_std: {label:"电流波动",unit:"%",min:0,max:100,warning:8,critical:20}
} as const;
