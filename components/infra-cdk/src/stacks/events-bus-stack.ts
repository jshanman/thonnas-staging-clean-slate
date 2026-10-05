// @intent SNS topic + per-consumer SQS queues with DLQ and filter subscriptions
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { EnvProfile } from '../cdk/env-profiles';
import type { EventsBusQueuePlan } from '../events/events-bus-plan';

export interface EventsBusStackProps extends StackProps {
  profile: EnvProfile;
  topicName: string;
  queues: EventsBusQueuePlan[];
}

function constructId(consumerId: string, suffix: string): string {
  const base = consumerId.replace(/[^A-Za-z0-9]/g, '') || 'Consumer';
  return `${base}${suffix}`;
}

// @intent Provision the domain-event bus: one topic, one queue+DLQ per consumerId
export class EventsBusStack extends Stack {
  readonly topic: sns.Topic;
  readonly queueNames: string[];
  readonly dlqNames: string[];
  readonly queueUrlMap: Record<string, string>;

  constructor(scope: Construct, id: string, props: EventsBusStackProps) {
    super(scope, id, props);

    const removal =
      props.profile.category === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.topic = new sns.Topic(this, 'EventsTopic', {
      topicName: props.topicName,
      displayName: props.topicName,
    });
    this.topic.applyRemovalPolicy(removal);

    this.queueNames = [];
    this.dlqNames = [];
    this.queueUrlMap = {};

    for (const queuePlan of props.queues) {
      const dlq = new sqs.Queue(this, constructId(queuePlan.consumerId, 'Dlq'), {
        queueName: queuePlan.dlqName,
        retentionPeriod: Duration.days(14),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
      });
      dlq.applyRemovalPolicy(removal);

      const queue = new sqs.Queue(this, constructId(queuePlan.consumerId, 'Queue'), {
        queueName: queuePlan.queueName,
        visibilityTimeout: Duration.seconds(60),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        deadLetterQueue: {
          queue: dlq,
          maxReceiveCount: 5,
        },
      });
      queue.applyRemovalPolicy(removal);

      if (queuePlan.filterPolicy.eventType.length > 0) {
        const filterPolicy: { [key: string]: sns.SubscriptionFilter } = {
          eventType: sns.SubscriptionFilter.stringFilter({
            allowlist: queuePlan.filterPolicy.eventType,
          }),
        };
        if (queuePlan.filterPolicy.aggregateId?.length) {
          filterPolicy.aggregateId = sns.SubscriptionFilter.stringFilter({
            allowlist: queuePlan.filterPolicy.aggregateId,
          });
        }
        this.topic.addSubscription(
          new snsSubs.SqsSubscription(queue, {
            rawMessageDelivery: true,
            filterPolicy,
          }),
        );
      }

      this.queueNames.push(queuePlan.queueName);
      this.dlqNames.push(queuePlan.dlqName);
      this.queueUrlMap[queuePlan.consumerId] = queue.queueUrl;
    }

    new CfnOutput(this, 'TopicArn', {
      value: this.topic.topicArn,
      description: 'QUEUE_SNS_TOPIC_ARN',
    });
    new CfnOutput(this, 'TopicName', {
      value: props.topicName,
      description: 'SNS topic name ({project}-{envCode}-thonnas-events)',
    });
    new CfnOutput(this, 'QueueUrlMap', {
      value: JSON.stringify(this.queueUrlMap),
      description: 'QUEUE_SNS_QUEUE_URL_MAP',
    });
    new CfnOutput(this, 'Region', {
      value: Stack.of(this).region,
      description: 'QUEUE_SNS_REGION',
    });
  }
}



