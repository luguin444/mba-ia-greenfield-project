import {
  mapProbeOutput,
  thumbnailTimestamp,
  type FfprobeOutput,
} from './media-metadata.util';
import { InvalidMediaError } from './media-tools.errors';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
};
const audioStream = { codec_type: 'audio', codec_name: 'aac' };

describe('mapProbeOutput', () => {
  it('should map the format and the first video and audio streams', () => {
    const output: FfprobeOutput = {
      format: { duration: '125.480000', format_name: 'mov,mp4,m4a' },
      streams: [
        audioStream,
        videoStream,
        { codec_type: 'video', codec_name: 'mjpeg', width: 320, height: 240 },
        { codec_type: 'audio', codec_name: 'opus' },
      ],
    };

    expect(mapProbeOutput(output)).toEqual({
      durationSeconds: 125.48,
      formatName: 'mov,mp4,m4a',
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });

  it('should return a null audioCodec when there is no audio stream', () => {
    const output: FfprobeOutput = {
      format: { duration: '2.0', format_name: 'matroska,webm' },
      streams: [videoStream],
    };

    expect(mapProbeOutput(output).audioCodec).toBeNull();
  });

  it('should return a null duration when ffprobe reports none or "N/A"', () => {
    expect(
      mapProbeOutput({ streams: [videoStream] }).durationSeconds,
    ).toBeNull();
    expect(
      mapProbeOutput({ format: { duration: 'N/A' }, streams: [videoStream] })
        .durationSeconds,
    ).toBeNull();
  });

  it('should throw InvalidMediaError when there is no video stream', () => {
    const audioOnly: FfprobeOutput = {
      format: { duration: '30.0', format_name: 'mp3' },
      streams: [audioStream],
    };

    expect(() => mapProbeOutput(audioOnly)).toThrow(InvalidMediaError);
    expect(() => mapProbeOutput({})).toThrow(InvalidMediaError);
  });
});

describe('thumbnailTimestamp', () => {
  it('should take the frame at 10% of a short video', () => {
    expect(thumbnailTimestamp(2)).toBeCloseTo(0.2);
    expect(thumbnailTimestamp(45)).toBeCloseTo(4.5);
  });

  it('should cap the offset at 10 s for long videos', () => {
    expect(thumbnailTimestamp(100)).toBe(10);
    expect(thumbnailTimestamp(7200)).toBe(10);
  });

  it('should use the first frame when the duration is unknown or under 1 s', () => {
    expect(thumbnailTimestamp(null)).toBe(0);
    expect(thumbnailTimestamp(Number.NaN)).toBe(0);
    expect(thumbnailTimestamp(0.6)).toBe(0);
  });
});
