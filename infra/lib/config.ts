/**
 * Environment configuration for TradeWizard infrastructure.
 * Supports development and production environments with different resource sizing.
 *
 * Cost-optimized: No NAT Gateways, no ElastiCache.
 * RDS in public subnet with strict security group + SSL enforcement.
 * DynamoDB replaces Redis for dedup/cache (pay-per-request, pennies at low volume).
 *
 * Scale-up path: When revenue justifies it, add NAT + private subnets + ElastiCache
 * by changing config values - no architecture changes needed.
 */

export type EnvironmentName = 'development' | 'production';

export interface EnvironmentConfig {
  envName: EnvironmentName;
  account: string;
  region: string;
  vpcCidr: string;
  rds: {
    // These three are not read by the stack today: database-stack.ts hardcodes
    // db.t4g.micro, 20 GB (auto-expanding to 50 GB) and single-AZ. They are kept
    // so sizing can move into config without reshaping the interface.
    instanceClass: string;
    allocatedStorage: number;
    multiAz: boolean;
    publiclyAccessible: boolean;
  };
  deletionProtection: boolean;
  removalPolicy: 'DESTROY' | 'RETAIN';
  // Wallet subscription configuration
  platformWalletAddress: string;
  usdcContractAddress: string;
  polygonRpcUrl: string;
  safeFactoryAddress: string;
}

export function getEnvironmentConfig(envName: EnvironmentName): EnvironmentConfig {
  const configs: Record<EnvironmentName, EnvironmentConfig> = {
    development: {
      envName: 'development',
      account: process.env.CDK_DEFAULT_ACCOUNT || '',
      region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
      vpcCidr: getDeploymentNamespace() ? '10.2.0.0/16' : '10.0.0.0/16',
      rds: {
        instanceClass: 't4g.micro',
        allocatedStorage: 20,
        multiAz: false,
        publiclyAccessible: true,
      },
      deletionProtection: false,
      removalPolicy: 'DESTROY',
      platformWalletAddress: process.env.PLATFORM_WALLET_ADDRESS || '',
      usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
      safeFactoryAddress: process.env.SAFE_FACTORY_ADDRESS || '',
    },
    production: {
      envName: 'production',
      account: process.env.CDK_DEFAULT_ACCOUNT || '',
      region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
      vpcCidr: getDeploymentNamespace() ? '10.3.0.0/16' : '10.1.0.0/16',
      rds: {
        instanceClass: 't4g.micro',
        allocatedStorage: 20,
        multiAz: false,
        publiclyAccessible: true,
      },
      deletionProtection: true,
      removalPolicy: 'RETAIN',
      platformWalletAddress: process.env.PLATFORM_WALLET_ADDRESS || '',
      usdcContractAddress: process.env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
      polygonRpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
      safeFactoryAddress: process.env.SAFE_FACTORY_ADDRESS || '',
    },
  };

  return configs[envName];
}

/**
 * Optional deployment namespace.
 *
 * Set `DEPLOYMENT_NAMESPACE` to run a second, fully independent deployment in
 * the same account and region - e.g. a hackathon build alongside a live
 * environment. Every resource name, stack name and CloudFormation export then
 * carries the namespace, so the two cannot collide or overwrite each other.
 *
 * Unset (the default) keeps the original naming exactly, so existing
 * deployments are unaffected.
 */
export function getDeploymentNamespace(): string {
  return (process.env.DEPLOYMENT_NAMESPACE ?? '').trim().toLowerCase();
}

/** Prefix for all resource names to avoid collisions */
export function resourceName(envName: EnvironmentName, name: string): string {
  const prefix = envName === 'production' ? 'tw-prod' : 'tw-dev';
  const namespace = getDeploymentNamespace();
  return namespace ? `${prefix}-${namespace}-${name}` : `${prefix}-${name}`;
}
