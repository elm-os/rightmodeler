// Internal notification email sent to the team when someone submits the feedback form, or when a
// coding agent sends feedback for its user (see lib/handle-feedback.ts; lib/feedback.ts writes the
// lines it shows). Built with React Email components so it renders cleanly across mail
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
import { feedbackLines, type Feedback } from "@/lib/feedback";

type FeedbackNotificationProps = Feedback & { submittedAt: string };

export function FeedbackNotification({
  submittedAt,
  ...feedback
}: FeedbackNotificationProps) {
  const { subject, details, footer } = feedbackLines(feedback, submittedAt);
  return (
    <Html lang="en">
      <Head />
      <Preview>{subject}</Preview>
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
            {feedback.via === "agent" ? "Agent feedback" : "Feedback"}
          </Text>
          <Heading
            style={{ fontSize: "18px", fontWeight: 600, margin: "0 0 12px" }}
          >
            New message
          </Heading>
          {feedback.email && (
            <Text
              style={{ fontSize: "16px", margin: "0 0 12px", color: "#000000" }}
            >
              {feedback.email}
            </Text>
          )}
          {details.length > 0 && (
            <Text
              style={{
                fontSize: "14px",
                lineHeight: "1.5",
                margin: "0 0 12px",
                color: "#777169",
                whiteSpace: "pre-wrap",
              }}
            >
              {details.join("\n")}
            </Text>
          )}
          <Text
            style={{
              fontSize: "14px",
              lineHeight: "1.5",
              margin: "0 0 16px",
              padding: "12px 16px",
              backgroundColor: "#f5f3f1",
              border: "1px solid #e5e5e5",
              borderRadius: "8px",
              color: "#000000",
              whiteSpace: "pre-wrap",
            }}
          >
            {feedback.message}
          </Text>
          <Text style={{ fontSize: "12px", margin: 0, color: "#a59f97" }}>
            {footer}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default FeedbackNotification;
