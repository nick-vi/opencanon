export const CompanyStatus = {
  Active: "active",
  Archived: "archived",
} as const;

export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];
