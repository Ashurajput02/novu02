import { Injectable, Logger } from '@nestjs/common';
import { MessageRepository, JobRepository, JobStatusEnum } from '@novu/dal';
import {
  StepTypeEnum,
  ExecutionDetailsSourceEnum,
  ExecutionDetailsStatusEnum,
  DigestTypeEnum,
  IDigestRegularMetadata,
} from '@novu/shared';
import {
  DetailEnum,
  CreateExecutionDetails,
  CreateExecutionDetailsCommand,
  GetUseMergedDigestId,
  FeatureFlagCommand,
} from '@novu/application-generic';

import { GetDigestEventsRegular } from './get-digest-events-regular.usecase';
import { GetDigestEventsBackoff } from './get-digest-events-backoff.usecase';

import { CreateLog } from '../../../../shared/logs';
import { PlatformException } from '../../../../shared/utils';

import { SendMessageCommand } from '../send-message.command';
import { SendMessageType } from '../send-message-type.usecase';
import { DigestEventsCommand } from './digest-events.command';

const LOG_CONTEXT = 'Digest';

@Injectable()
export class Digest extends SendMessageType {
  constructor(
    protected messageRepository: MessageRepository,
    protected createLogUsecase: CreateLog,
    protected createExecutionDetails: CreateExecutionDetails,
    protected jobRepository: JobRepository,
    private getDigestEventsRegular: GetDigestEventsRegular,
    private getDigestEventsBackoff: GetDigestEventsBackoff,
    private getUseMergedDigestId: GetUseMergedDigestId
  ) {
    super(messageRepository, createLogUsecase, createExecutionDetails);
  }

  public async execute(command: SendMessageCommand) {
    const useMergedDigestId = await this.getUseMergedDigestId.execute(
      FeatureFlagCommand.create({
        environmentId: command.environmentId,
        organizationId: command.organizationId,
        userId: command.userId,
      })
    );

    const getEvents = useMergedDigestId ? this.getEvents.bind(this) : this.backwardCompatibleGetEvents.bind(this);

    const events = await getEvents(command);
    const nextJobs = await this.getJobsToUpdate(command);

    await this.createExecutionDetails.execute(
      CreateExecutionDetailsCommand.create({
        ...CreateExecutionDetailsCommand.getDetailsFromJob(command.job),
        detail: DetailEnum.DIGESTED_EVENTS_PROVIDED,
        source: ExecutionDetailsSourceEnum.INTERNAL,
        status: ExecutionDetailsStatusEnum.SUCCESS,
        isTest: false,
        isRetry: false,
        raw: JSON.stringify(nextJobs),
      })
    );

    await this.jobRepository.update(
      {
        _environmentId: command.environmentId,
        _id: {
          $in: nextJobs.map((job) => job._id),
        },
      },
      {
        $set: {
          'digest.events': events,
        },
      }
    );
  }

  private async getEvents(command: SendMessageCommand) {
    const currentJob = await this.getCurrentJob(command);

    const jobs = await this.jobRepository.find(
      {
        _mergedDigestId: currentJob._id,
        status: JobStatusEnum.MERGED,
        type: StepTypeEnum.DIGEST,
        _environmentId: currentJob._environmentId,
        _subscriberId: command._subscriberId,
      },
      'payload'
    );

    return [currentJob.payload, ...jobs.map((job) => job.payload)];
  }

  private async backwardCompatibleGetEvents(command: SendMessageCommand) {
    const currentJob = await this.getCurrentJob(command);

    const digestEventsCommand = DigestEventsCommand.create({
      currentJob,
      _subscriberId: command._subscriberId,
    });

    if (
      currentJob?.digest?.type === DigestTypeEnum.BACKOFF ||
      (currentJob?.digest as IDigestRegularMetadata)?.backoff
    ) {
      return this.getDigestEventsBackoff.execute(digestEventsCommand);
    }

    return this.getDigestEventsRegular.execute(digestEventsCommand);
  }

  private async getCurrentJob(command: SendMessageCommand) {
    const currentJob = await this.jobRepository.findOne({ _environmentId: command.environmentId, _id: command.jobId });

    if (!currentJob) {
      const message = `Digest job ${command.jobId} is not found`;
      Logger.error(message, LOG_CONTEXT);
      throw new PlatformException(message);
    }

    return currentJob;
  }

  private async getJobsToUpdate(command: SendMessageCommand) {
    const nextJobs = await this.jobRepository.find({
      _environmentId: command.environmentId,
      transactionId: command.transactionId,
      _subscriberId: command._subscriberId,
      _id: {
        $ne: command.jobId,
      },
    });

    return nextJobs.filter((job) => {
      if (job.type === StepTypeEnum.IN_APP && job.status === JobStatusEnum.COMPLETED) {
        return true;
      }

      return job.status !== JobStatusEnum.COMPLETED && job.status !== JobStatusEnum.FAILED;
    });
  }
}
