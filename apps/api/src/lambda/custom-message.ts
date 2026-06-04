import type { CustomMessageTriggerEvent, CustomMessageTriggerHandler } from "aws-lambda";

const APP_DOMAIN = process.env.APP_DOMAIN || "example.com";

export const handler: CustomMessageTriggerHandler = async (event) => {
  const { codeParameter, usernameParameter } = event.request;

  switch (event.triggerSource) {
    case "CustomMessage_SignUp":
    case "CustomMessage_ResendCode":
      event.response.emailSubject = "Verify your Trellis account";
      event.response.emailMessage = `
        <p>Welcome to Trellis!</p>
        <p>Your verification code is: <strong>${codeParameter}</strong></p>
        <p>This code expires in 24 hours.</p>
      `;
      break;

    case "CustomMessage_ForgotPassword":
      event.response.emailSubject = "Reset your Trellis password";
      event.response.emailMessage = `
        <p>You requested a password reset.</p>
        <p>Your reset code is: <strong>${codeParameter}</strong></p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `;
      break;
  }

  return event;
};
