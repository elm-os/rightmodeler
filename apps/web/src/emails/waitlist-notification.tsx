// Internal notification email sent to the team when someone joins a waitlist (Crucible or the
// agent; see app/api/waitlist/route.ts). Built with React Email components so it renders cleanly across mail
// clients; kept plain and monochrome — it's an ops notification, not a marketing send. Colours are
// the design tokens from docs/design.md, inlined (email clients don't get the app's CSS).

import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";

interface WaitlistNotificationProps {
  email: string;
  submittedAt: string;
  product?: "crucible" | "agent";
}

export function WaitlistNotification({
  email,
  submittedAt,
  product = "crucible",
}: WaitlistNotificationProps) {
  const label = product === "agent" ? "rightmodeler agent" : "Crucible";
  return (
    <Html lang="en">
      <Head />
      <Preview>New {label} waitlist signup: {email}</Preview>
      <Body
        style={{
          backgroundColor: "#fdfcfc",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          color: "#000000",
          margin: 0,
        }}
      >
        <Container
          style={{ maxWidth: "480px", margin: "0 auto", padding: "24px" }}
        >
          <Text
            style={{
              fontSize: "12px",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#a59f97",
              margin: "0 0 8px",
            }}
          >
            {label} waitlist
          </Text>
          <Heading
            style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 12px" }}
          >
            New signup
          </Heading>
          <Text
            style={{ fontSize: "16px", margin: "0 0 8px", color: "#000000" }}
          >
            {email}
          </Text>
          <Text style={{ fontSize: "12px", margin: 0, color: "#a59f97" }}>
            Submitted {submittedAt} · rightmodeler.com/{product}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default WaitlistNotification;
