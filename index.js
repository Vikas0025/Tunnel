const ngrok = require("@ngrok/ngrok");
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

// Your VPN endpoint
const FORWARD_ENDPOINT = `${process.env.SERVICE_BASE_URL}/v1/webhooks/port-in`;
const PORT = process.env.PORT ?? 3000;

// Store ngrok URL
let ngrokListener = null;

// Middleware to log requests
app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} - call back received ${req.method} ${
      req.path
    }`,
    req.body
  );
  console.log(`forwarding to ${FORWARD_ENDPOINT}`);
  next();
});

// Forward all requests to VPN endpoint
app.use("/", async (req, res) => {
  try {
    // Forward the request to VPN endpoint with original method, headers and body
    const response = await axios({
      method: req.method,
      url: FORWARD_ENDPOINT,
      headers: {
        ...req.headers,
        host: new URL(FORWARD_ENDPOINT).host, // Replace host header
      },
      data: req.body,
      validateStatus: false, // Don't throw on non-2xx responses
    });
    console.log(
      `response from ${FORWARD_ENDPOINT}`,
      response.status,
      response.data
    );

    // Forward the response back
    res.status(response.status).send(response.data);
  } catch (error) {
    console.error(
      "Error forwarding request:",
      error.message,
      "Error response:",
      error.response?.data
    );
    res.status(500).json({ error: "Failed to forward request" });
  }
});

// Start the server and create ngrok tunnel
async function startServer() {
  try {
    await checkServiceStatus();
    // Start express server
    app.listen(PORT, () => {
      console.log(
        `Server is running on port ${PORT}, will be forwarding requests to ${FORWARD_ENDPOINT}`
      );
    });

    // Configure ngrok
    if (process.env.NGROK_AUTH_TOKEN) {
      await ngrok.authtoken(process.env.NGROK_AUTH_TOKEN);
    }

    let ngrokUrl = "";

    // Start ngrok tunnel
    try {
      ngrokListener = await ngrok.forward({
        addr: PORT,
        // onLogEvent: (logEventMessage) => {
        //   console.log("Ngrok log event:", logEventMessage);
        // },
      });
      ngrokUrl = ngrokListener.url();
      console.log(`Ngrok tunnel established at: ${ngrokUrl}`);
    } catch (error) {
      console.error("Failed to start ngrok tunnel:", error);
      process.exit(1);
    }

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      await updateTwilioWebhook(`${ngrokUrl}/api`);
    }
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Update Twilio webhook URL
async function updateTwilioWebhook(portInTargetUrl) {
  try {
    console.log("Updating Twilio webhook URL to: ", portInTargetUrl);
    const response = await axios.post(
      "https://numbers.twilio.com/v1/Porting/Configuration/Webhook",
      {
        port_in_target_url: portInTargetUrl,
      },
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
          ).toString("base64")}`,
        },
      }
    );
    console.log("Updated Twilio webhook URL to:", portInTargetUrl);
    return response.data;
  } catch (error) {
    console.error(
      "Failed to update Twilio webhook:",
      error.message,
      error.response?.data
    );
  }
}

async function checkServiceStatus() {
  try {
    const healthCheckEndpoint = `${process.env.SERVICE_BASE_URL}/v1/health/check`;
    await axios.get(healthCheckEndpoint);
    console.log("Forwarding service is healthy and running...");
  } catch (error) {
    if (error.response?.status === 403) {
      console.error("Please check if VPN is connected...");
      process.exit(1);
    } else if (error.response?.status === 503) {
      console.error("Forwarding service unavailable...");
    } else {
      console.error("Error checking service status:", error.message);
    }
  }
}

// Handle shutdown
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

async function cleanup() {
  try {
    console.log("Closing ngrok listener");
    await ngrokListener.close();
    process.exit(0);
  } catch (error) {
    console.error("Failed to cleanup: ", error);
    process.exit(1);
  }
}

// Start the server
startServer();
