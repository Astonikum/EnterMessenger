const app = require('./app.json');

const projectId = process.env.EXPO_PROJECT_ID || app.expo.extra?.eas?.projectId || 'aaa033ad-a37f-4ad4-b608-394d0a21320e';

if (process.env.CI && !projectId) {
  throw new Error('EXPO_PROJECT_ID is required in CI for EAS builds');
}

module.exports = {
  ...app,
  expo: {
    ...app.expo,
    ...(process.env.EXPO_OWNER ? { owner: process.env.EXPO_OWNER } : {}),
    ...(projectId
      ? {
          extra: {
            ...app.expo.extra,
            eas: {
              ...app.expo.extra?.eas,
              projectId,
            },
          },
        }
      : {}),
  },
};
