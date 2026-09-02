/**
 * B.4.1 — Admin dashboard entry. The Operational Command Center lives in
 * DashboardClient (data + interactivity); this page is the server boundary.
 */
import DashboardClient from "./DashboardClient";

export default function AdminDashboardPage() {
  return <DashboardClient />;
}
