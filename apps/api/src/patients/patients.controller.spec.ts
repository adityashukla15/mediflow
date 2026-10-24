
import { Test, TestingModule } from '@nestjs/testing';
import { PatientsController } from './patients.controller.js';
import { PatientsService } from './patients.service.js';
import { MedicalRecordsService } from '../medical-records/medical-records.service.js';

describe('PatientsController', () => {
  let controller: PatientsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PatientsController],
      providers: [
        {
          provide: PatientsService,
          useValue: {},
        },
        {
          provide: MedicalRecordsService,
          useValue: {
            findForPatient: vi.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<PatientsController>(PatientsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
