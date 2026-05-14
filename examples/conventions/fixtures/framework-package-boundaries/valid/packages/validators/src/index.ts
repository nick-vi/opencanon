import { defineValidator } from "@opencanon/core";

export const validator = defineValidator({
  id: "valid-validator",
  validate() {
    return [];
  },
});
