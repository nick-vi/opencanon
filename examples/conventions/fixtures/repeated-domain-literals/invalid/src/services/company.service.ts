export function isActive(status: string) {
  return status === "active";
}

export function activeFilter() {
  return { status: "active" };
}

export function loadActiveCompany() {
  return findByStatus("active");
}

function findByStatus(status: string) {
  return status;
}
