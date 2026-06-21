import { EnrollButton } from "./enroll-button";

// The example's one page: a form that enrolls a contact into the welcome drip. The whole point
// of the dogfood app is to exercise the compliance-critical primitives against a real Resend
// account — enroll here, watch the drip cron send + advance, then unsubscribe from the email's
// one-click link and confirm the consent mirror gate blocks the next step.
export default function Home() {
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>@envoy/sdk example</h1>
      <p>
        Enroll a contact into the <code>welcome</code> drip sequence. Then run the drip cron
        (<code>GET /api/envoy/cron/drip</code>) and the broadcast cron
        (<code>GET /api/envoy/cron/broadcast</code>) — see the README.
      </p>
      <EnrollButton />
    </main>
  );
}
