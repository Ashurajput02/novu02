import {
  ChannelTypeEnum,
  ISendMessageSuccessResponse,
  IEmailOptions,
  IEmailProvider,
  ICheckIntegrationResponse,
  CheckIntegrationResponseEnum,
} from '@novu/stateless';
import { randomUUID } from 'crypto';
import SparkPost from 'sparkpost';

export class SparkPostEmailProvider implements IEmailProvider {
  readonly id = 'sparkpost';
  readonly channelType = ChannelTypeEnum.EMAIL as ChannelTypeEnum.EMAIL;
  private readonly client: SparkPost;

  constructor(
    private config: {
      apiKey: string;
      region: string;
      from: string;
      senderName: string;
    }
  ) {
    const endpoint = this.getEndpoint(config.region);
    this.client = new SparkPost(config.apiKey, {
      endpoint,
    });
  }

  async sendMessage({
    from,
    to,
    subject,
    text,
    html,
    attachments,
  }: IEmailOptions): Promise<ISendMessageSuccessResponse> {
    const recipients: { address: string }[] = to.map((recipient) => {
      return { address: recipient };
    });

    const files: Array<{ name: string; type: string; data: string }> = [];

    attachments?.forEach((attachment) => {
      files.push({
        name: attachment.name || randomUUID(),
        type: attachment.mime,
        data: attachment.file.toString('base64'),
      });
    });

    const sent = await this.client.transmissions.send({
      recipients,
      content: {
        from: from || this.config.from,
        subject,
        text,
        html,
        attachments: files,
      },
    });

    return {
      id: sent.results.id,
      date: new Date().toISOString(),
    };
  }

  async checkIntegration(
    options: IEmailOptions
  ): Promise<ICheckIntegrationResponse> {
    try {
      await this.sendMessage({
        to: ['no-reply@novu.co'],
        from: this.config.from || options.from,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });

      return {
        success: true,
        message: 'Integrated successfully!',
        code: CheckIntegrationResponseEnum.SUCCESS,
      };
    } catch (error) {
      return {
        success: false,
        message: error?.message,
        code: CheckIntegrationResponseEnum.FAILED,
      };
    }
  }

  private transformLegacyRegion(region: string | boolean) {
    if (region === 'true' || region === true) return 'eu';

    return region;
  }

  private getEndpoint(_region: string) {
    const region = this.transformLegacyRegion(_region);

    switch (region) {
      case 'eu':
        return 'https://api.eu.sparkpost.com:443';
      default:
        return;
    }
  }
}
