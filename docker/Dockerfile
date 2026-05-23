# Use the official AWS Lambda ARM64 Node.js 22 base image
FROM public.ecr.aws/lambda/nodejs:22-arm64

# Copy pre-built distribution files
COPY dist/ ${LAMBDA_TASK_ROOT}/

# Default CMD -- each Lambda function is configured with ENV HANDLER=dispatcher
# or HANDLER=verifier in the Lambda configuration, not here.
CMD [ "index.handler" ]
