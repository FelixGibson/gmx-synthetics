import { hashString } from "./hash";
import hre from "hardhat";

export async function grantRole(roleStore, account, role) {
  await roleStore.grantRole(account, hashString(role));
}

export async function grantRoleIfNotGranted(address: string, role: string) {
  const { deployments, getNamedAccounts } = hre;
  const { read, execute, log } = deployments;
  const { deployer } = await getNamedAccounts();

  const hasRole = await read("RoleStore", "hasRole", address, hashString(role));
  if (!hasRole) {
    log("granting role %s to %s", role, address);
    await execute("RoleStore", { from: deployer, log: true }, "grantRole", address, hashString(role));
  } else {
    log("role %s already granted to %s", role, address);
  }
}
