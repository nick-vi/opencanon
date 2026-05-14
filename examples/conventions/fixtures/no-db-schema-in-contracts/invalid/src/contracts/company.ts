import { companies } from "../db/schema/company";

export type CompanyDto = typeof companies.$inferSelect;
