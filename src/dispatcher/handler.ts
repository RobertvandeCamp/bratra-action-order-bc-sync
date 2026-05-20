import type { ScheduledEvent, Context } from 'aws-lambda';

// TODO Phase 151: implementeer order fetching, envelope mapping, SB send
export const handler = async (event: ScheduledEvent, context: Context): Promise<void> => {
  console.log('Dispatcher handler invoked', { event, requestId: context.awsRequestId });
};
