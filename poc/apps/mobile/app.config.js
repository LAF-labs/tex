// app.json 위에 로컬 값만 얹는다. Apple 팀 ID는 저장소에 두지 않고 APPLE_TEAM_ID 환경 변수로만 받는다(실기기·EAS 빌드용).
// 시뮬레이터 빌드에는 필요 없다(README "시뮬레이터 빌드").
module.exports = ({ config }) => {
  const team = process.env.APPLE_TEAM_ID;
  if (team !== undefined && !/^[A-Z0-9]{10}$/.test(team)) throw new Error('APPLE_TEAM_ID must be the 10-character Apple team ID');
  return team ? { ...config, ios: { ...config.ios, appleTeamId: team } } : config;
};
