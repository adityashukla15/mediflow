
import { Test, TestingModule } from '@nestjs/testing';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';

describe('AppointmentsController', () => {
  let controller: AppointmentsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppointmentsController],
      providers: [
        {
          provide: AppointmentsService,
          useValue: {
            create: vi.fn(),
            findAll: vi.fn(),
            reschedule: vi.fn(),
            updateStatus: vi.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AppointmentsController>(
      AppointmentsController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
