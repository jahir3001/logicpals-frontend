import { routeAlert } from "./alert_router.js";

async function main() {
  try {
    await routeAlert("deployment_event", {
      environment: "production",
      status: "success",
      version: "v1"
    });
    console.log("Alert routed successfully");
  } catch (error) {
    console.error("Alert router test failed:", error.message);
    process.exit(1);
  }
}

main();