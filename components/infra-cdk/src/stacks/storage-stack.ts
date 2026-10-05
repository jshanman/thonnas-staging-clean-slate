// @intent Create S3 bucket(s) for infra.storage strategy (e.g. Verdaccio package storage)
import { Stack, StackProps } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import { PlannedResource, ResolvedCloudComponent } from '../types';

export interface StorageStackProps extends StackProps {
  profile: EnvProfile;
  component: ResolvedCloudComponent;
  /** Planned resources with kind s3StorageBucket (one bucket per resource, name from props.bucket) */
  resources: PlannedResource[];
}

// @intent Provision or import one S3 bucket per s3StorageBucket; reuse when ThonnasBucketExists is true
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { resources } = props;

    const storageResources = resources.filter((r) => r.kind === 's3StorageBucket');
    storageResources.forEach((res, i) => {
      const raw =
        (res.props?.bucket as string | undefined) ??
        (res.props?.bucketName as string | undefined) ??
        '';
      const bucketName = typeof raw === 'string' ? raw.trim() : '';
      if (!bucketName) return;
      const bucketExistsKey = `ThonnasBucketExists:${bucketName}`;
      const bucketExistsInAws = this.node.tryGetContext(bucketExistsKey) === 'true';
      if (bucketExistsInAws) {
        s3.Bucket.fromBucketName(this, `Bucket${i}`, bucketName);
      } else {
        new s3.Bucket(this, `Bucket${i}`, {
          bucketName,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          enforceSSL: true,
        });
      }
    });
  }
}



