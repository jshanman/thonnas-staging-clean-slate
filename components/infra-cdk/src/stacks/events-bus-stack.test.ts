import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from '@jest/globals';
import { EventsBusStack } from './events-bus-stack';

describe('EventsBusStack', () => {
  it('creates a topic, queue, DLQ, and filtered SQS subscription', () => {
    const app = new App();
    const stack = new EventsBusStack(app, 'TestEventsBus', {
      profile: {
        envKey: 'beta',
        category: 'beta',
        stackPrefix: 'Beta',
        networkingStackPrefix: 'Beta',
        wiringStackPrefix: 'Beta',
        composeHostStackPrefix: 'Beta',
        enablePrivateSubnets: false,
        createNatGateway: false,
        allowFargate: true,
        requireAlb: false,
      },
      topicName: 'beta-thonnas-events',
      queues: [
        {
          consumerId: 'tm-user-entitlements',
          queueName: 'beta-thonnas-tm-user-entitlements',
          dlqName: 'beta-thonnas-tm-user-entitlements-dlq',
          filterPolicy: {
            eventType: ['commerce.entitlement.granted', 'commerce.entitlement.revoked'],
          },
        },
      ],
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'beta-thonnas-events' });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'beta-thonnas-tm-user-entitlements',
      VisibilityTimeout: 60,
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'beta-thonnas-tm-user-entitlements-dlq',
    });
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'sqs',
      RawMessageDelivery: true,
      FilterPolicy: Match.objectLike({
        eventType: ['commerce.entitlement.granted', 'commerce.entitlement.revoked'],
      }),
    });
    expect(JSON.stringify(template.toJSON())).toContain('TopicArn');
    expect(JSON.stringify(template.toJSON())).toContain('QueueUrlMap');
  });
});



