import * as session from "../js/session.js";
import { testAsync } from "./runner.js";

function mockClient(initialSession, profiles, refreshedSession) {
  let authCallback = null;
  const profileQuery = {
    selected: "",
    id: "",
    select(columns) {
      this.selected = columns;
      return this;
    },
    eq(_column, id) {
      this.id = id;
      return this;
    },
    async maybeSingle() {
      return { data: profiles[this.id] || null, error: null };
    },
  };

  return {
    auth: {
      async getSession() {
        return { data: { session: initialSession }, error: null };
      },
      onAuthStateChange(callback) {
        authCallback = callback;
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async refreshSession() {
        return { data: { session: refreshedSession }, error: null };
      },
      async signOut() {
        return { error: null };
      },
    },
    from() {
      return profileQuery;
    },
    emit(event, nextSession) {
      authCallback(event, nextSession);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

testAsync("[session] auth events refresh profile state while JWT remains the role source", async (t) => {
  session._resetForTests();
  const first = {
    user: {
      id: "one",
      email: "one@example.com",
      app_metadata: { roles: ["player"] },
      user_metadata: {},
    },
  };
  const refreshed = {
    user: {
      id: "one",
      email: "one@example.com",
      app_metadata: { roles: ["treasurer"] },
      user_metadata: {},
    },
  };
  const client = mockClient(first, {
    one: {
      id: "one",
      email: "one@example.com",
      display_name: "Example Member",
      roles: ["admin"],
    },
  }, refreshed);

  await session.initSession(client);
  t.equal(session.getProfile().displayName, "Example Member");
  t.equal(session.getRoles().join(","), "player", "profile roles must not grant access");

  client.emit("SIGNED_OUT", null);
  await tick();
  t.assert(!session.isAuthenticated(), "signed-out events must clear the session");
  t.equal(session.getProfile(), null, "signed-out events must clear the profile");

  client.emit("SIGNED_IN", first);
  await tick();
  t.assert(session.isAuthenticated(), "signed-in events must restore session state");

  await session.refreshAccess(client);
  t.equal(session.getRoles().join(","), "treasurer", "token refresh must update visible roles");

  await session.signOut(client);
  t.assert(!session.isAuthenticated(), "explicit sign-out must clear local state");
  session._resetForTests();
});
