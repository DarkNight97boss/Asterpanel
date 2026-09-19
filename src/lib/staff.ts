import type { StaffRole, UserRole } from "@/db/schema";

/** Staff roles and the back-office areas they open. Pure: no request state in here. */

export type StaffArea = "platform" | "clients" | "billing" | "support" | "content";

export const STAFF_AREAS: StaffArea[] = ["platform", "clients", "billing", "support", "content"];

const GRANTS: Record<StaffRole, StaffArea[]> = {
  manager: ["platform", "clients", "billing", "support", "content"],
  ops: ["platform", "clients", "support"],
  support: ["clients", "support"],
  billing: ["clients", "billing"],
  content: ["content"],
};

export const STAFF_ROLES = Object.keys(GRANTS) as StaffRole[];

export const STAFF_ROLE_LABEL: Record<StaffRole | "admin", string> = {
  admin: "Administrator",
  manager: "Manager",
  ops: "Operations",
  support: "Support agent",
  billing: "Billing agent",
  content: "Content editor",
};

export const STAFF_ROLE_HELP: Record<StaffRole, string> = {
  manager: "Every area of the back office, except settings, servers and staff.",
  ops: "Workloads and jobs, client records and tickets.",
  support: "Tickets and client records.",
  billing: "Orders, services, invoices, products and client records.",
  content: "Website pages and menus.",
};

export const AREA_LABEL: Record<StaffArea, string> = { platform: "Platform", clients: "Clients", billing: "Billing", support: "Support", content: "Website" };

type Who = { role: UserRole; staffRole: StaffRole | "" } | null;

/** Administrators can do everything; staff without a role (older accounts) count as managers. */
export const staffAreas = (user: Who): StaffArea[] => (!user || user.role === "client" ? [] : user.role === "admin" ? STAFF_AREAS : GRANTS[user.staffRole || "manager"]);
export const staffCan = (user: Who, area: StaffArea) => staffAreas(user).includes(area);

/** Where a staff member lands when an area is closed to them. */
export const AREA_HOME: Record<StaffArea, string> = { platform: "/admin/workloads", clients: "/admin/clients", billing: "/admin/invoices", support: "/admin/tickets", content: "/admin/pages" };
