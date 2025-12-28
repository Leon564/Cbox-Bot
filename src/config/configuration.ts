export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  
  // CBox Configuration
  cbox: {
    url: process.env.CBOX_URL,
    username: process.env.CBOX_USERNAME,
    password: process.env.CBOX_PASSWORD,
    defaultPic: process.env.CBOX_DEFAULT_PIC,
  },
  
  // OpenAI Configuration
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  
  // Bot Configuration
  bot: {
    responseDelay: parseInt(process.env.RESPONSE_DELAY || '20500', 10),
    maxLengthResponse: parseInt(process.env.MAX_LENGTH_RESPONSE || '200', 10),
    textColor: process.env.TEXT_COLOR,
    useMemory: process.env.USE_MEMORY === 'true',
    moderationEnabled: process.env.MODERATION_ENABLED === 'true',
    autoModerateAll: process.env.AUTO_MODERATE_ALL === 'true',
    autoDeleteMessages: process.env.AUTO_DELETE_MESSAGES === 'true',
    moderationOnlyMode: process.env.MODERATION_ONLY_MODE === 'true',
    sendModerationWarnings: process.env.SEND_MODERATION_WARNINGS !== 'false',
  },
});