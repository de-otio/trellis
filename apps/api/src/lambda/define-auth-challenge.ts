export const handler = async (event: any) => {
  const session = event.request.session;

  if (session.length === 0) {
    // No attempts yet — issue a custom challenge
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
  } else if (
    session.length === 1 &&
    session[0].challengeName === "CUSTOM_CHALLENGE" &&
    session[0].challengeResult === true
  ) {
    // Challenge answered correctly — issue tokens
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else {
    // Unexpected state — fail
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  }

  return event;
};
