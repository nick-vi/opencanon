export function db() {
  return {
    select() {
      return {
        where(_input: unknown) {
          return [{ id: "company_1" }];
        },
      };
    },
  };
}
